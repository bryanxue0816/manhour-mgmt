import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_STATE_SCHEMA_VERSION,
  alertStatePathFor,
  baselineState,
  checkedState,
  failedState,
  intentStateFor,
  readAlertState,
  sentState,
  toStateInstant,
  touchedState,
  writeAlertState,
  type AlertState,
} from "@/lib/alerts/alert-state";

describe("alert-state file IO", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "alert-state-"));
    file = join(dir, "alert-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when the state file is absent", async () => {
    expect(await readAlertState(file)).toBeNull();
  });

  it("round-trips every field through temp-plus-rename write", async () => {
    const now = new Date("2026-09-11T01:20:00.000Z"); // 09:20 +08:00
    const original: AlertState = {
      schemaVersion: ALERT_STATE_SCHEMA_VERSION,
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-11",
      lastRecoveryDate: null,
      lastCheckAt: toStateInstant(now),
      lastAttemptAt: toStateInstant(now),
      lastSentAt: toStateInstant(now),
      lastError: null,
    };

    await writeAlertState(file, original);

    expect(await readAlertState(file)).toEqual(original);
  });

  it("leaves no temp file behind after writing", async () => {
    await writeAlertState(file, baselineState(new Date()));

    expect(await readdir(dir)).toEqual(["alert-state.json"]);
  });

  it("treats corrupt JSON as null and logs state-corrupt", async () => {
    const log = vi.fn();
    vi.stubGlobal("console", { ...console, log });
    await writeFile(file, "{not json");

    expect(await readAlertState(file)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("state-corrupt"));
  });

  it.each([
    ["an unknown schemaVersion", { schemaVersion: 999 }],
    ["a missing required field", { schemaVersion: 1, lastState: "ok" }],
  ])("treats %s as null", async (_label, raw) => {
    await writeFile(file, JSON.stringify(raw));

    expect(await readAlertState(file)).toBeNull();
  });

  it("tolerates unknown future fields", async () => {
    const baseline = baselineState(new Date("2026-09-11T01:20:00.000Z"));
    await writeFile(file, JSON.stringify({ ...baseline, futureField: "keep-me" }));

    expect(await readAlertState(file)).toEqual(baseline);
  });

  it("derives the state path next to the SQLite file", () => {
    expect(alertStatePathFor("file:/app/data/dev.db")).toBe("/app/data/alert-state.json");
  });
});

describe("alert-state transitions", () => {
  const now = new Date("2026-09-11T01:20:00.000Z");

  it("records the first alert date when sending the first alert", () => {
    const intent = intentStateFor(baselineState(now), "send-first", "2026-09-11", now);

    expect(intent).toMatchObject({
      lastState: "stale",
      firstAlertDate: "2026-09-11",
      lastAlertDate: "2026-09-11",
    });
    expect(intent.lastAttemptAt).toBe(toStateInstant(now));
  });

  it("keeps the first alert date on a repeat", () => {
    const prev: AlertState = {
      ...baselineState(now),
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
    };

    const intent = intentStateFor(prev, "send-repeat", "2026-09-11", now);

    expect(intent.firstAlertDate).toBe("2026-09-08");
    expect(intent.lastAlertDate).toBe("2026-09-11");
  });

  it("marks recovery without erasing alert history", () => {
    const prev: AlertState = {
      ...baselineState(now),
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
    };

    const intent = intentStateFor(prev, "send-recovery", "2026-09-11", now);

    expect(intent).toMatchObject({
      lastState: "ok",
      lastRecoveryDate: "2026-09-11",
      firstAlertDate: "2026-09-08",
    });
  });

  it("renders business-time instants with a fixed +08:00 offset", () => {
    expect(toStateInstant(now)).toBe("2026-09-11T09:20:00+08:00");
  });

  it("records success and failure without mutating the intent", () => {
    const intent = intentStateFor(baselineState(now), "send-first", "2026-09-11", now);

    const succeeded = sentState(intent, now);
    const failed = failedState(intent, "connect ETIMEDOUT");
    const touched = touchedState(failed, now);

    expect(succeeded.lastSentAt).toBe(toStateInstant(now));
    expect(succeeded.lastError).toBeNull();
    expect(failed.lastError).toBe("connect ETIMEDOUT");
    expect(failed.lastSentAt).toBeNull();
    expect(intent.lastError).toBeNull();
    expect(checkedState(failed, now, "stale").lastCheckAt).toBe(toStateInstant(now));
    // Dry-run touch refreshes attempt stamps without changing cadence or state.
    expect(touched.lastAttemptAt).toBe(toStateInstant(now));
    expect(touched.lastState).toBe(failed.lastState);
    // Spec errata E (2026-09-12): the approved spec wrote toBeNull() here, but
    // `failed` inherits the send-first intent's lastAlertDate by design (same-day
    // retry suppression after a failed send depends on it), and touchedState must
    // not move cadence dates. Assert the actual contract: the date is untouched.
    expect(touched.lastAlertDate).toBe(failed.lastAlertDate);
  });
});
