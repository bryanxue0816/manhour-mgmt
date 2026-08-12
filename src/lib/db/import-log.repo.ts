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
 */
export async function appendImportLog(input: ImportLogInput): Promise<ImportLogDto> {
  const status = assertImportStatus(input.status);
  const triggeredBy = assertImportTrigger(input.triggeredBy);
  const rowCount = status === "FAILED" ? 0 : (input.rowCount ?? 0);
  const row = await prisma.importLog.create({
    data: {
      fileName: input.fileName,
      fileMtime: input.fileMtime ?? null,
      status,
      rowCount,
      errorMessage: normaliseErrorMessage(input.errorMessage),
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
