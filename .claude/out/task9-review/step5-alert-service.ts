// One attendance staleness scan, orchestrated from injected dependencies so the
// whole pipeline is testable with in-memory fakes (no fs, nodemailer or prisma
// at import time). Crash-safety rule: for live sends the INTENT is persisted
// before delivery, so a crash between the two costs at most one email and
// never causes a resend storm on the same day.

import {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  describeImportStaleness,
  type StalenessLevel,
} from "@/lib/attendance/import-staleness";
import { businessDayOf, formatDateOnly } from "@/lib/db/date";

import {
  baselineState,
  checkedState,
  failedState,
  intentStateFor,
  sentState,
  touchedState,
} from "./alert-state";
import type { AlertState } from "./alert-state";
import { decideAlertAction } from "./alert-decision";
import type { AlertDecisionKind } from "./alert-decision";
import { buildRecoveryEmail, buildStaleAlertEmail } from "./alert-template";
import type { AlertEmailConfig } from "./email-config";
import type { SendEmailInput, SendEmailResult } from "./email-sender";

export interface AlertCheckDeps {
  now: () => Date;
  config: AlertEmailConfig;
  findLatestSuccessAt: () => Promise<Date | null>;
  readState: () => Promise<AlertState | null>;
  writeState: (state: AlertState) => Promise<void>;
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  log: (record: Record<string, unknown>) => void;
}

export type AlertErrorCode =
  | "config-error"
  | "send-failed"
  | "db-read-failed"
  | "state-write-failed";

export interface AlertCheckResult {
  decision: AlertDecisionKind;
  exitCode: 0 | 1 | 2;
  errorCode?: AlertErrorCode;
}

export function exitCodeFor(errorCode: AlertErrorCode | undefined): 0 | 1 | 2 {
  if (errorCode === "config-error" || errorCode === "send-failed") return 1;
  if (errorCode === "db-read-failed" || errorCode === "state-write-failed") return 2;
  return 0;
}

function done(
  decision: AlertDecisionKind,
  errorCode: AlertErrorCode | undefined,
  log: (record: Record<string, unknown>) => void,
): AlertCheckResult {
  const exitCode = exitCodeFor(errorCode);
  log({ evt: "scan-done", exitCode });
  return { decision, exitCode, ...(errorCode === undefined ? {} : { errorCode }) };
}

export async function runAttendanceAlertCheck(
  deps: AlertCheckDeps,
): Promise<AlertCheckResult> {
  const { now, config, log } = deps;
  const instant = now();
  log({ evt: "scan-start" });

  // Step 1: database read. Failure short-circuits before any state IO.
  let latestSuccessAt: Date | null;
  try {
    latestSuccessAt = await deps.findLatestSuccessAt();
  } catch (error) {
    log({ evt: "db-read-failed", error: error instanceof Error ? error.message : String(error) });
    return done("skip", "db-read-failed", log);
  }

  // Step 2: compute the signal and the business calendar day.
  const staleness = describeImportStaleness(
    latestSuccessAt,
    instant,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
  );
  const today = formatDateOnly(businessDayOf(instant));

  // Step 3: config gate. With config-error, sending is impossible and touching
  // cadence state would be meaningless.
  if (config.mode === "config-error") {
    log({ evt: "config-error", errors: config.errors });
    return done("skip", "config-error", log);
  }

  // Step 4: read state (corrupt files are already normalised to null) + decide.
  const prev = await deps.readState();
  const decision = decideAlertAction({ level: staleness.level, today, state: prev });
  log({
    evt: "alert-decision",
    level: staleness.level,
    daysSince: staleness.daysSince,
    decision: decision.kind,
  });

  // Step 5a: dry-run NEVER creates the state file and advances NO cadence
  // field. spec 5.1.7 states this for sending decisions; arbitration A
  // extends the same rule to skip/baseline, because the container dry-run
  // verification asserts the file stays absent on a healthy system too.
  // Sending decisions still render the mail and log one dry-run line per
  // stale scan, which is exactly what the cron verification greps for.
  if (config.mode === "dry-run") {
    if (decision.kind !== "skip" && decision.kind !== "baseline") {
      const mail = buildMail(
        decision.kind,
        staleness.level,
        staleness.daysSince,
        latestSuccessAt,
        instant,
      );
      await deps.send({ to: config.adminEmails, subject: mail.subject, text: mail.text });
    }
    if (prev !== null) {
      // Existing file: check/attempt stamps only, lastState and every date kept.
      try {
        await deps.writeState(touchedState(prev, instant));
      } catch (error) {
        // A touch failure must not upgrade a dry run to exit 2.
        log({
          evt: "state-write-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return done(decision.kind, undefined, log);
  }

  // Step 5b (live): non-sending paths refresh the check stamp / set baseline.
  if (decision.kind === "skip" || decision.kind === "baseline") {
    const next: AlertState =
      decision.kind === "baseline"
        ? baselineState(instant)
        : checkedState(prev ?? baselineState(instant), instant, decision.tracked);
    try {
      await deps.writeState(next);
    } catch (error) {
      log({
        evt: "state-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return done(decision.kind, "state-write-failed", log);
    }
    return done(decision.kind, undefined, log);
  }

  // Step 5c (live): persist intent FIRST; a failed intent write forbids
  // the send entirely.
  const base = prev ?? baselineState(instant);
  const intent = intentStateFor(base, decision.kind, today, instant);
  try {
    await deps.writeState(intent);
  } catch (error) {
    log({
      evt: "state-write-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return done(decision.kind, "state-write-failed", log);
  }

  const mail = buildMail(
    decision.kind,
    staleness.level,
    staleness.daysSince,
    latestSuccessAt,
    instant,
  );
  const result = await deps.send({
    to: config.adminEmails,
    subject: mail.subject,
    text: mail.text,
  });

  if (result.delivered) {
    try {
      await deps.writeState(sentState(intent, instant));
    } catch (error) {
      // The email is already out. Intent dates suppress a same-day resend;
      // surface the failed bookkeeping as an infra exit code.
      log({
        evt: "state-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return done(decision.kind, "state-write-failed", log);
    }
    // The sender owns the delivery events ("alert-email-sent"); the service
    // logs only orchestration, so each event appears exactly once per run.
    return done(decision.kind, undefined, log);
  }

  log({ evt: "alert-email-failed", error: result.error ?? "unknown" });
  try {
    await deps.writeState(failedState(intent, result.error ?? "unknown"));
  } catch (error) {
    log({
      evt: "state-write-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return done(decision.kind, "state-write-failed", log);
  }
  return done(decision.kind, "send-failed", log);
}

function buildMail(
  kind: AlertDecisionKind,
  level: StalenessLevel,
  daysSince: number | null,
  latestSuccessAt: Date | null,
  now: Date,
): { subject: string; text: string } {
  // send-recovery only happens at level "ok", where a successful timestamp exists.
  if (kind === "send-recovery") {
    return buildRecoveryEmail({ latestSuccessAt: latestSuccessAt as Date, now });
  }
  return buildStaleAlertEmail({
    level,
    daysSince,
    latestSuccessAt,
    now,
  });
}
