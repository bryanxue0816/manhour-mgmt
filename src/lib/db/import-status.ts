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
 * Trims an error summary to something a status panel can render.
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
