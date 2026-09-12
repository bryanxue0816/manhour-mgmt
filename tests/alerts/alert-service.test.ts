import { describe, expect, it } from "vitest";

import { runAttendanceAlertCheck, type AlertCheckDeps } from "@/lib/alerts/alert-service";
import type { AlertEmailConfig } from "@/lib/alerts/email-config";
import type { AlertState } from "@/lib/alerts/alert-state";
import type { SendEmailInput, SendEmailResult } from "@/lib/alerts/email-sender";

const NOW = new Date("2026-09-11T01:20:00.000Z"); // 09:20 +08:00, a Friday
const NEXT_DAY = new Date("2026-09-12T01:20:00.000Z");
const STALE_SUCCESS = new Date("2026-09-05T01:07:00.000Z"); // six business days before NOW
const HEALTHY_SUCCESS = new Date("2026-09-11T01:07:00.000Z");

const liveConfig: AlertEmailConfig = {
  mode: "live",
  host: "mail.internal",
  port: 25,
  secure: false,
  user: null,
  pass: null,
  from: "sys@x.com",
  adminEmails: ["ops@x.com"],
};
const dryRunConfig: AlertEmailConfig = {
  mode: "dry-run",
  reason: "smtp-not-configured",
  adminEmails: [],
};
const configError: AlertEmailConfig = { mode: "config-error", errors: ["SMTP_FROM missing"] };

const liveOk: SendEmailResult = { delivered: true, dryRun: false };
const liveFail: SendEmailResult = {
  delivered: false,
  dryRun: false,
  error: "connect ETIMEDOUT",
};

interface HarnessOptions {
  latest: Date | null | "throw";
  initial?: AlertState | null;
  config?: AlertEmailConfig;
  queue?: SendEmailResult[];
  rejectIntentWrite?: boolean;
}

interface Harness {
  deps: AlertCheckDeps;
  sent: SendEmailInput[];
  results: SendEmailResult[];
  logs: Record<string, unknown>[];
  store: () => AlertState | null;
  advanceOneDay: () => void;
}

function harness(options: HarnessOptions): Harness {
  let state: AlertState | null = options.initial ?? null;
  let clock: Date = NOW;
  const sent: SendEmailInput[] = [];
  const results: SendEmailResult[] = [];
  const logs: Record<string, unknown>[] = [];
  const defaultResult: SendEmailResult =
    options.config?.mode === "dry-run"
      ? { delivered: true, dryRun: true }
      : liveOk;
  const queue = [...(options.queue ?? [defaultResult])];

  const deps: AlertCheckDeps = {
    now: () => clock,
    config: options.config ?? liveConfig,
    findLatestSuccessAt: async () => {
      if (options.latest === "throw") throw new Error("db down");
      return options.latest;
    },
    readState: async () => state,
    writeState: async (next) => {
      if (options.rejectIntentWrite && next.lastAttemptAt !== state?.lastAttemptAt) {
        throw new Error("disk full");
      }
      state = structuredClone(next);
    },
    send: async (input) => {
      sent.push(input);
      // Erratum M-A: fall back to defaultResult (dry/live per config), never a
      // hardcoded liveOk that would mislabel a second dry-run delivery.
      const result = queue.shift() ?? defaultResult;
      results.push(result);
      if (result.dryRun) logs.push({ evt: "alert-email-dry-run" });
      return result;
    },
    log: (record) => void logs.push(record),
  };

  return {
    deps,
    sent,
    results,
    logs,
    store: () => state,
    advanceOneDay: () => {
      clock = NEXT_DAY;
    },
  };
}

describe("runAttendanceAlertCheck", () => {
  it("persists the send intent BEFORE the first live alert goes out", async () => {
    const h = harness({ latest: STALE_SUCCESS });
    // Erratum M-C: hold the observed state in an object; a let-bound value
    // assigned only inside this closure is narrowed to never by TS at the read.
    const observed: { stateAtSend: AlertState | null } = { stateAtSend: null };
    const originalSend = h.deps.send;
    h.deps.send = async (input) => {
      observed.stateAtSend = h.store(); // Observed from inside the sender: ordering is the contract.
      return originalSend(input);
    };

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "send-first", exitCode: 0 });
    expect(h.sent).toHaveLength(1);
    expect(observed.stateAtSend?.lastAlertDate).toBe("2026-09-11");
    expect(h.store()?.lastSentAt).not.toBeNull();
  });

  it("does not send twice within the same business day", async () => {
    const h = harness({ latest: STALE_SUCCESS });

    await runAttendanceAlertCheck(h.deps);
    const second = await runAttendanceAlertCheck(h.deps);

    expect(h.sent).toHaveLength(1);
    expect(second.decision).toBe("skip");
  });

  it("sends at most one repeat per next business day", async () => {
    const h = harness({ latest: STALE_SUCCESS });
    await runAttendanceAlertCheck(h.deps);

    h.advanceOneDay();
    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-repeat");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.subject).toContain("已 7 天");
  });

  it("grants baseline grace on the first scan of a never-imported system", async () => {
    const h = harness({ latest: null });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "baseline", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()?.lastState).toBe("baseline");
  });

  it("alerts on the second scan when imports have still never happened", async () => {
    const h = harness({
      latest: null,
      initial: {
        schemaVersion: 1,
        lastState: "baseline",
        firstAlertDate: null,
        lastAlertDate: null,
        lastRecoveryDate: null,
        lastCheckAt: null,
        lastAttemptAt: null,
        lastSentAt: null,
        lastError: null,
      },
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-first");
    expect(h.sent).toHaveLength(1);
  });

  it("sends recovery when imports resume and records the recovery date", async () => {
    const h = harness({
      latest: HEALTHY_SUCCESS,
      initial: {
        schemaVersion: 1,
        lastState: "stale",
        firstAlertDate: "2026-09-08",
        lastAlertDate: "2026-09-10",
        lastRecoveryDate: null,
        lastCheckAt: null,
        lastAttemptAt: null,
        lastSentAt: null,
        lastError: null,
      },
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-recovery");
    expect(h.sent[0]?.subject).toContain("已恢复正常");
    expect(h.store()).toMatchObject({ lastState: "ok", lastRecoveryDate: "2026-09-11" });
  });

  it("logs dry-run delivery without advancing any cadence date, twice on the same day", async () => {
    const h = harness({ latest: STALE_SUCCESS, config: dryRunConfig });

    const first = await runAttendanceAlertCheck(h.deps);
    const second = await runAttendanceAlertCheck(h.deps);

    expect(first).toMatchObject({ decision: "send-first", exitCode: 0 });
    // Erratum M-D: dry-run writes no state, so prev stays null and the second
    // scan decides send-first again instead of being suppressed same-day.
    expect(second).toMatchObject({ decision: "send-first", exitCode: 0 });
    expect(h.sent).toHaveLength(2);
    expect(h.logs.filter((l) => l.evt === "alert-email-dry-run")).toHaveLength(2);
    expect(h.store()).toBeNull(); // No file created: dry-run never persists send cadence.
  });

  it("still sends the live first alert on cutover day after dry-runs", async () => {
    const dry = harness({ latest: STALE_SUCCESS, config: dryRunConfig });
    await runAttendanceAlertCheck(dry.deps);

    const live = harness({ latest: STALE_SUCCESS, config: liveConfig });
    const result = await runAttendanceAlertCheck(live.deps);

    expect(result.decision).toBe("send-first");
    // Erratum M-B: dryRun lives on SendEmailResult, not the SendEmailInput in sent[].
    expect(live.results[0]?.dryRun).toBe(false);
  });

  it("records a live send failure and does not retry within the same day", async () => {
    const h = harness({ latest: STALE_SUCCESS, queue: [liveFail] });

    const failed = await runAttendanceAlertCheck(h.deps);
    const retried = await runAttendanceAlertCheck(h.deps);

    expect(failed).toMatchObject({ exitCode: 1, errorCode: "send-failed" });
    expect(h.store()).toMatchObject({ lastError: "connect ETIMEDOUT", lastSentAt: null });
    expect(h.sent).toHaveLength(1); // Intent dated today suppresses the same-day retry.
    expect(retried.exitCode).toBe(0);
  });

  it("exits 1 on config-error without sending or touching state", async () => {
    const h = harness({ latest: STALE_SUCCESS, config: configError });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 1, errorCode: "config-error" });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("exits 2 when the database read fails, with no send and no state write", async () => {
    const h = harness({ latest: "throw" });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 2, errorCode: "db-read-failed" });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("exits 2 and never sends when the intent write fails", async () => {
    const h = harness({ latest: STALE_SUCCESS, rejectIntentWrite: true });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 2, errorCode: "state-write-failed" });
    expect(h.sent).toHaveLength(0);
  });

  // Plan-added cases (arbitration A extension): dry-run never creates the
  // state file on ANY decision, not just the three sending decisions.

  it("creates no state file on a dry-run cold-start baseline", async () => {
    const h = harness({ latest: null, config: dryRunConfig });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "baseline", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("creates no state file on a healthy dry-run skip", async () => {
    const h = harness({ latest: HEALTHY_SUCCESS, config: dryRunConfig });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "skip", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("only touches stamps on a dry-run recovery scan with an existing file", async () => {
    const stale: AlertState = {
      schemaVersion: 1,
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
      lastRecoveryDate: null,
      lastCheckAt: "2026-09-10T15:00:00+08:00",
      lastAttemptAt: null,
      lastSentAt: null,
      lastError: null,
    };
    const h = harness({
      latest: HEALTHY_SUCCESS,
      config: dryRunConfig,
      initial: structuredClone(stale),
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-recovery");
    expect(h.sent).toHaveLength(1); // Dry-run "delivery" for log verification.
    expect(h.store()).toMatchObject({
      lastState: "stale", // Preserved: dry-run never rewrites tracked state.
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
      lastRecoveryDate: null,
    });
  });
});
