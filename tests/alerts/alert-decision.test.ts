import { describe, expect, it } from "vitest";

import { decideAlertAction } from "@/lib/alerts/alert-decision";
import type { AlertState } from "@/lib/alerts/alert-state";

function state(partial: Partial<AlertState>): AlertState {
  return {
    schemaVersion: 1,
    lastState: "ok",
    firstAlertDate: null,
    lastAlertDate: null,
    lastRecoveryDate: null,
    lastCheckAt: null,
    lastAttemptAt: null,
    lastSentAt: null,
    lastError: null,
    ...partial,
  };
}

describe("decideAlertAction", () => {
  it("skips on the first ever scan when imports are healthy", () => {
    const decision = decideAlertAction({ level: "ok", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "skip", tracked: "ok" });
  });

  it("sends the first alert when stale data is found with no prior state", () => {
    const decision = decideAlertAction({ level: "stale", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "send-first", tracked: "stale" });
  });

  it("grants a one-scan baseline grace when there has never been a successful import", () => {
    const decision = decideAlertAction({ level: "never", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "baseline", tracked: "baseline" });
  });

  // Erratum I (2026-09-12): spec §7.1 wrote the second column as "stale" in
  // both rows, but the title ("after the baseline scan") and matrix §5.1.4
  // ("stale or never | baseline -> send-first") call for "baseline"; the
  // stale+null-date combination is unreachable in the state machine.
  it.each([
    ["stale", "baseline"],
    ["never", "baseline"],
  ] as const)(
    "sends the first alert on %s after the baseline scan",
    (level, lastState) => {
      const decision = decideAlertAction({
        level,
        today: "2026-09-11",
        state: state({ lastState }),
      });

      expect(decision.kind).toBe("send-first");
    },
  );

  it("sends a first alert when staleness starts after a healthy history", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-11",
      state: state({ lastState: "ok" }),
    });

    expect(decision).toEqual({ kind: "send-first", tracked: "stale" });
  });

  it("does not repeat an alert within the same business day", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-11",
      state: state({ lastState: "stale", lastAlertDate: "2026-09-11" }),
    });

    expect(decision).toEqual({ kind: "skip", tracked: "stale" });
  });

  it("repeats the alert on the next business day", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastAlertDate: "2026-09-11" }),
    });

    expect(decision).toEqual({ kind: "send-repeat", tracked: "stale" });
  });

  it("sends a recovery notice when imports resume after an alert", () => {
    const decision = decideAlertAction({
      level: "ok",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastRecoveryDate: null }),
    });

    expect(decision).toEqual({ kind: "send-recovery", tracked: "ok" });
  });

  it("keeps recovery idempotent within the same business day", () => {
    const decision = decideAlertAction({
      level: "ok",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastRecoveryDate: "2026-09-12" }),
    });

    expect(decision).toEqual({ kind: "skip", tracked: "ok" });
  });

  it.each([
    ["ok", "ok"],
    ["ok", "baseline"],
  ] as const)("skips when level=%s and lastState=%s", (level, lastState) => {
    const decision = decideAlertAction({
      level,
      today: "2026-09-11",
      state: state({ lastState }),
    });

    expect(decision.kind).toBe("skip");
  });

  it("defensively treats never-after-ok as a first alert", () => {
    const decision = decideAlertAction({
      level: "never",
      today: "2026-09-11",
      state: state({ lastState: "ok" }),
    });

    expect(decision.kind).toBe("send-first");
  });
});
