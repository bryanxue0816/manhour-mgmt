// Pure decision matrix for the attendance staleness alert cadence:
// first alert, at most one repeat per business calendar day, one recovery
// notice, and a one-scan baseline grace for a never-imported empty database.

import type { StalenessLevel } from "@/lib/attendance/import-staleness";

import type { AlertState, AlertTrackedState } from "./alert-state";

export type AlertDecisionKind =
  | "skip"
  | "baseline"
  | "send-first"
  | "send-repeat"
  | "send-recovery";

export interface AlertDecision {
  kind: AlertDecisionKind;
  tracked: AlertTrackedState;
}

export function decideAlertAction(input: {
  level: StalenessLevel;
  today: string;
  state: AlertState | null;
}): AlertDecision {
  const { level, today, state } = input;

  if (level === "ok") {
    if (state === null || state.lastState === "ok" || state.lastState === "baseline") {
      return { kind: "skip", tracked: "ok" };
    }
    // Healthy again after a stale streak: one recovery notice, idempotent
    // within the same business day.
    if (state.lastRecoveryDate === today) {
      return { kind: "skip", tracked: "ok" };
    }
    return { kind: "send-recovery", tracked: "ok" };
  }

  // Cold-start grace, one scan only, for a system with no successful import
  // and no history file.
  if (level === "never" && state === null) {
    return { kind: "baseline", tracked: "baseline" };
  }

  if (state === null) {
    return { kind: "send-first", tracked: "stale" };
  }

  if (state.lastState === "baseline" || state.lastState === "ok") {
    // Defensive: never after an ok/baseline history is theoretically
    // unreachable (never means no success ever), but treat it as a first
    // alert rather than silently going quiet.
    return { kind: "send-first", tracked: "stale" };
  }

  // lastState === "stale": at most one alert per business calendar day.
  if (state.lastAlertDate !== null && state.lastAlertDate >= today) {
    return { kind: "skip", tracked: "stale" };
  }
  return { kind: "send-repeat", tracked: "stale" };
}
