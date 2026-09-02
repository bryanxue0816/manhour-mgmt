// Import-log repository: the audit trail behind every attendance fetch (D-123).
//
// This table answers three questions that nothing else in the schema can:
//   - provenance: "which file did this month's figures come from"
//   - idempotence: "has this file already been imported successfully" (D-123), so a
//     re-scan of 目录 A skips what it already has instead of re-folding the month
//   - alerting: "how long since the last SUCCESS" (D-124), which is the only signal that
//     HR's export has stopped arriving - a silent gap otherwise looks like a quiet week
//
// Every attempt is logged, INCLUDING failures. A failed import that leaves no row is
// indistinguishable from an import that never ran, and D-124's staleness alert (N 个自然日
// 无成功导入) cannot fire on data that does not exist. The threshold is counted in calendar
// days, not working days: D-168 revoked WorkCalendar, so there is no working-day predicate
// left to count with, and a rest-day upload is a SUCCESS under D-170 anyway.
//
// SQLite has no enum, so `status` and `triggeredBy` are TEXT columns. The vocabularies
// live here as frozen tuples and every write goes through assertImportStatus /
// assertImportTrigger, so a typo fails loudly at the boundary rather than becoming a
// fourth status that no query filters on. [PG] both become real enums.

import { prisma } from "@/lib/prisma";
import {
  IMPORT_STATUSES,
  IMPORT_TRIGGERS,
  assertImportStatus,
  assertImportTrigger,
  completenessFieldsFor,
  normaliseErrorMessage,
} from "./import-status";
import type { ImportLogDto, ImportLogInput } from "./types";

export {
  IMPORT_STATUSES,
  IMPORT_TRIGGERS,
  assertImportStatus,
  assertImportTrigger,
};

/**
 * The vocabularies and their validators live in ./import-status, a prisma-free module,
 * so a unit test can exercise them without lib/prisma.ts constructing a database client
 * at module load. They are re-exported here because callers that already depend on this
 * repository should not need a second import to name a status.
 */

/** Default page size for the status panel - a few weeks of daily imports. */
const DEFAULT_HISTORY_LIMIT = 30;


/** Prisma row -> DTO, narrowing the two TEXT columns back to their unions. */
function toImportLogDto(row: {
  id: string;
  fileName: string;
  fileMtime: Date | null;
  importedAt: Date;
  status: string;
  rowCount: number;
  errorMessage: string | null;
  warningMessage: string | null;
  unexplainedZeroRatio: number | null;
  supersededCount: number;
  triggeredBy: string;
}): ImportLogDto {
  return {
    id: row.id,
    fileName: row.fileName,
    fileMtime: row.fileMtime,
    importedAt: row.importedAt,
    status: assertImportStatus(row.status),
    rowCount: row.rowCount,
    errorMessage: row.errorMessage,
    warningMessage: row.warningMessage,
    unexplainedZeroRatio: row.unexplainedZeroRatio,
    supersededCount: row.supersededCount,
    triggeredBy: assertImportTrigger(row.triggeredBy),
  };
}

/**
 * Appends one import-log entry.
 *
 * Append-only: an attempt is never updated or deleted, because the value of the table is
 * that it records what happened, not what the current state is.
 *
 * `rowCount` is forced to 0 on FAILED rather than trusted from the caller. A failed
 * import stores nothing (importAttendanceRows wraps its writes in a transaction), so a
 * non-zero count there would be a lie that the /actuals panel would display as progress.
 *
 * `supersededCount` (D-229) is forced to 0 on FAILED for the same reason and by the same
 * mechanism: the supersede pass runs inside that same transaction, so a failure rolled it
 * back, and every row HR removed is still live.
 *
 * Both D-222 fields are dropped on FAILED for the same reason - see
 * `completenessFieldsFor()`, which holds that rule so it can be asserted without a database.
 * Enforced here rather than left to callers, because this repository is the only writer.
 */
export async function appendImportLog(input: ImportLogInput): Promise<ImportLogDto> {
  const status = assertImportStatus(input.status);
  const triggeredBy = assertImportTrigger(input.triggeredBy);
  const rowCount = status === "FAILED" ? 0 : (input.rowCount ?? 0);
  const supersededCount = status === "FAILED" ? 0 : (input.supersededCount ?? 0);
  const completeness = completenessFieldsFor(status, input);
  const row = await prisma.importLog.create({
    data: {
      fileName: input.fileName,
      fileMtime: input.fileMtime ?? null,
      status,
      rowCount,
      errorMessage: normaliseErrorMessage(input.errorMessage),
      warningMessage: completeness.warningMessage,
      unexplainedZeroRatio: completeness.unexplainedZeroRatio,
      supersededCount,
      triggeredBy,
    },
  });
  return toImportLogDto(row);
}

/** Most recent attempts first, for the /actuals status panel. */
export async function findRecentImportLogs(
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<ImportLogDto[]> {
  const rows = await prisma.importLog.findMany({
    orderBy: { importedAt: "desc" },
    take: Math.max(1, Math.trunc(limit)),
  });
  return rows.map(toImportLogDto);
}

export interface ImportLogPageQuery {
  limit?: number;
  offset?: number;
}

/**
 * One page of attempts, newest first, for the audit view's import tab (D-226).
 *
 * Ordered by `[importedAt desc, id desc]` where findRecentImportLogs gets away with
 * `importedAt` alone. A directory scan appends several rows inside the same second, and
 * SQLite may return such ties in any order between two queries - under LIMIT/OFFSET that
 * means page 1 and page 2 can both show one attempt and neither show another. The id is
 * not a meaningful "later than", it is just a total order, which is all paging needs.
 */
export async function findImportLogPage(
  query: ImportLogPageQuery = {},
): Promise<ImportLogDto[]> {
  const rows = await prisma.importLog.findMany({
    orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    take: query.limit ?? DEFAULT_HISTORY_LIMIT,
    skip: query.offset ?? 0,
  });
  return rows.map(toImportLogDto);
}

/**
 * Every attempt ever logged, failures included. Drives the audit tab counter and pager.
 *
 * Unfiltered on purpose: a count that quietly excluded FAILED rows would make the tab
 * label read as if nothing had gone wrong.
 */
export async function countImportLogs(): Promise<number> {
  return prisma.importLog.count();
}

/**
 * The latest attempt of any status, or null when nothing has ever been imported.
 *
 * Deliberately not filtered to SUCCESS: the panel has to be able to show "last night's
 * run FAILED", and a SUCCESS-only query would render a week-old success as if it were
 * the current state.
 */
export async function findLatestImportLog(): Promise<ImportLogDto | null> {
  const row = await prisma.importLog.findFirst({ orderBy: { importedAt: "desc" } });
  return row === null ? null : toImportLogDto(row);
}

/** The latest SUCCESS (or PARTIAL - rows did land), used to compute the staleness gap. */
export async function findLatestSuccessfulImportLog(): Promise<ImportLogDto | null> {
  const row = await prisma.importLog.findFirst({
    where: { status: { in: ["SUCCESS", "PARTIAL"] } },
    orderBy: { importedAt: "desc" },
  });
  return row === null ? null : toImportLogDto(row);
}

/**
 * Whether this file name has already been imported without failing (D-123 idempotence).
 *
 * PARTIAL counts as processed on purpose: its rows are already in the table, and a
 * re-import would re-run the same parse against the same file and reach the same
 * partial outcome. Recovering from PARTIAL is a `retry` the operator asks for, not
 * something a directory scan should decide on its own.
 *
 * D-120 promises file names are unique, so the name alone is the key. `fileMtime` is
 * stored anyway - if that promise ever breaks, the log already carries the evidence.
 */
export async function hasSuccessfulImport(fileName: string): Promise<boolean> {
  const found = await prisma.importLog.findFirst({
    where: { fileName, status: { in: ["SUCCESS", "PARTIAL"] } },
    select: { id: true },
  });
  return found !== null;
}
