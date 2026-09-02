// Import-log vocabularies and their validators. Prisma-free by design.
//
// Extracted from import-log.repo.ts for the same reason as section-key.ts: lib/prisma.ts
// constructs the client at module load, so anything importing the repository drags
// better-sqlite3 and DATABASE_URL into scope. These two vocabularies are the part worth
// unit-testing on their own - they are the only guard between a typo and a fourth silent
// status in a table that D-124's alerting reads.
//
// SQLite has no enum, so status and triggered_by are TEXT columns and this file IS the
// constraint. [PG] both become real enums and these asserts become belt-and-braces.

import type { ImportStatus, ImportTrigger } from "./types";

/** The only three legal values of `import_log.status` (D-123). */
export const IMPORT_STATUSES = ["SUCCESS", "FAILED", "PARTIAL"] as const;

/** The only three legal values of `import_log.triggered_by` (D-123). */
export const IMPORT_TRIGGERS = ["schedule", "manual", "retry"] as const;

/**
 * Narrows a stored string to ImportStatus, throwing on anything outside the vocabulary.
 *
 * Compared VERBATIM - no trim, no case folding. `" SUCCESS"` and `"success"` are both
 * rejected on purpose: accepting them would mean two spellings of one status coexist in
 * the column, and `WHERE status = 'SUCCESS'` would quietly miss half the rows.
 */
export function assertImportStatus(value: string): ImportStatus {
  const found = IMPORT_STATUSES.find((s) => s === value);
  if (found === undefined) {
    throw new Error(
      `import_log.status 非法值：${JSON.stringify(value)}。` +
        `允许值：${IMPORT_STATUSES.join(" / ")}。`,
    );
  }
  return found;
}

/** Narrows a stored string to ImportTrigger, throwing on anything outside the vocabulary. */
export function assertImportTrigger(value: string): ImportTrigger {
  const found = IMPORT_TRIGGERS.find((t) => t === value);
  if (found === undefined) {
    throw new Error(
      `import_log.triggered_by 非法值：${JSON.stringify(value)}。` +
        `允许值：${IMPORT_TRIGGERS.join(" / ")}。`,
    );
  }
  return found;
}

/** Longest stored `errorMessage`. A stack trace is useless in a status panel, and a
 * multi-megabyte one would make the /actuals page unreadable; the full text belongs in
 * the process log. */
export const MAX_ERROR_MESSAGE_LENGTH = 2000;

/**
 * Trims a stored note to something a status panel can render. Used for both
 * `errorMessage` and D-222's `warningMessage` - same column type, same rendering budget.
 *
 * Blank (or whitespace-only) becomes null so "no error" has exactly one representation:
 * an empty string in this column would make `errorMessage IS NOT NULL` report a failure
 * reason that does not exist.
 */
export function normaliseErrorMessage(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_ERROR_MESSAGE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…（已截断）`;
}

/**
 * Narrows a measured ratio to a stored 0..1 Float, or null.
 *
 * NaN and Infinity become null rather than being stored. A NaN in this column would
 * survive every comparison as false, so a later threshold re-derivation would read it as
 * a healthy day instead of as a missing measurement - the one outcome worse than no data.
 * Out-of-range values are clamped rather than dropped: the measurement is still evidence.
 */
export function normaliseRatio(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw));
}

/**
 * The D-222 completeness pair as it must be STORED, given the status the row landed with.
 *
 * Both fields are dropped on FAILED. The warning would point an operator at a completeness
 * problem in a day that has no rows at all - a failed import stores nothing, its writes are
 * rolled back in one transaction. And the ratio is the series meant to replace D-222's
 * single-day threshold, so it has to describe days that actually landed: a rolled-back file
 * would weight the calibration with hours nobody can read.
 *
 * Here rather than inline in `import-log.repo.ts` for the reason that module note gives for
 * this whole file: the repo builds its Prisma client at import time, so a rule expressed
 * there cannot be asserted without better-sqlite3 and DATABASE_URL. This is an invariant
 * worth a test, not a line worth trusting.
 */
export function completenessFieldsFor(
  status: ImportStatus,
  input: { warningMessage?: string | null; unexplainedZeroRatio?: number | null },
): { warningMessage: string | null; unexplainedZeroRatio: number | null } {
  if (status === "FAILED") {
    return { warningMessage: null, unexplainedZeroRatio: null };
  }
  return {
    warningMessage: normaliseErrorMessage(input.warningMessage),
    unexplainedZeroRatio: normaliseRatio(input.unexplainedZeroRatio),
  };
}
