// Attendance ingestion: turn a file on disk into stored rows plus one audit entry.
//
// This is the orchestration layer above parser.ts (pure) and attendance.repo.ts (writes).
// It owns exactly three things that neither of those should:
//   1. the filesystem - reading the bytes and stat'ing the mtime
//   2. the ImportLog entry, written on EVERY outcome including the failures (D-123/D-124)
//   3. the write and the one verdict only the write can produce (a FAILED insert)
//
// The verdict that depends only on the BYTES lives in verdict.ts, because the upload page
// must preview a file's status without writing it, and a second implementation of that
// logic is how the preview and the commit would start disagreeing.
//
// It is deliberately NOT in lib/db: it is not a repository, and keeping it out means the
// repositories stay free of `node:fs` and can still be reasoned about as pure database
// access. It is deliberately NOT in scripts/ either - the manual upload path (D-170's only
// entry point) needs the same orchestration, and duplicating it is how the two paths would
// start disagreeing about what counts as a failure.
//
// Nothing here throws to its caller. A fetch that crashes past the log write leaves no
// evidence, and "no ImportLog row" is indistinguishable from "the import never ran" -
// which is precisely the state D-124's alert is supposed to detect. Every failure is
// therefore captured, logged, and returned as data.
//
// Scheduling is NOT implemented here and by D-170 never will be: manual upload is the only
// entry point, so there is no trigger time to bake in. scripts/fetch-attendance.ts survives
// as an optional bypass for bulk backfill, not as the main path.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  parseAttendanceFile,
  type AttendanceProblem,
} from "@/lib/attendance/parser";
import {
  classifyAttendanceParse,
  joinWarnings,
  type AttendanceVerdict,
} from "@/lib/attendance/verdict";
import {
  affectedMonthsOf,
  importAttendanceRows,
  type AffectedMonth,
  type MonthRebuildResult,
} from "@/lib/db/attendance.repo";
import { formatDateOnly } from "@/lib/db/date";
import { appendImportLog, hasSuccessfulImport } from "@/lib/db/import-log.repo";
import type { ImportStatus, ImportTrigger } from "@/lib/db/types";

/**
 * File extensions accepted from the source directory.
 *
 * D-120 promises `attendance_YYYYMMDD.xls` "或类似格式", so the extension is the filter
 * rather than the full name pattern: a stricter regex would silently skip a renamed but
 * perfectly valid export, and a skipped file looks exactly like a file HR never wrote.
 *
 * `.csv` was added by D-221 for exactly that reason - HR's export switched to CSV, and
 * until this list knew the extension the auto-fetch path skipped every report without
 * writing an `import_log` row, which is indistinguishable from an empty share.
 */
const ATTENDANCE_EXTENSIONS = [".xls", ".xlsx", ".csv"] as const;

/**
 * Excel writes a `~$name.xls` lock file next to an open workbook. It is a few hundred
 * bytes of metadata, not a workbook, and parsing it produces a confusing failure.
 */
const LOCK_FILE_PREFIX = "~$";

/** One completed ingestion attempt, whatever its outcome. */
export interface IngestResult {
  status: ImportStatus;
  /** Base name, as recorded in import_log.file_name. */
  fileName: string;
  /** Null when the file could not be stat'ed - see ImportLogDto.fileMtime. */
  fileMtime: Date | null;
  /** Rows written to attendance_raw. Always 0 unless status is SUCCESS or PARTIAL. */
  rowsStored: number;
  /** One entry per fiscal month re-folded. Empty on FAILED. */
  months: readonly MonthRebuildResult[];
  /** Parse problems, when the parser rejected the file. */
  problems: readonly AttendanceProblem[];
  /** Human-readable failure summary, exactly as stored. Null on SUCCESS. */
  errorMessage: string | null;
  /**
   * D-222 completeness warnings, exactly as stored. Empty when the day looks complete.
   *
   * Never affects `status` - 只告警不拦截. The rows are valid and re-importing the same
   * day overwrites them, so refusing them would discard real hours to complain about
   * absent ones.
   */
  warnings: readonly string[];
  /** Measured unexplained-zero ratio, 0..1, or null when unmeasurable. */
  unexplainedZeroRatio: number | null;
  /**
   * D-229: rows marked superseded because HR deleted them since the earlier fetch.
   *
   * Reported separately from `rowsStored`, which counts rows WRITTEN. Without this, a
   * fetch that removed three people's day is indistinguishable from one that changed
   * nothing - the audit page would show two clean SUCCESS rows and no sign of the
   * reduction that moved the monthly total.
   */
  supersededCount: number;
  /**
   * Rows the file held but D-103 excluded (员工类别 ∉ {管理职, 管间人员}).
   *
   * Reported alongside `rowsStored` so the operator can reconcile the two numbers against
   * the file they just uploaded. Without it, a correct import of a 577-row export storing
   * 180 rows reads as having lost two thirds of the data.
   */
  categoryFilteredRows: number;
  /** id of the appended import_log row, or null if even the log write failed. */
  logId: string | null;
  /** True for a rest-day report: parsed cleanly, no employee rows (D-170). */
  isRestDay: boolean;
}

/** Bytes plus the identity the log needs. Used by both the file and the upload path. */
export interface AttendanceSource {
  buffer: Buffer;
  /** Base name only; a full path in import_log.file_name breaks D-123's name lookup. */
  fileName: string;
  fileMtime: Date | null;
  triggeredBy: ImportTrigger;
}

/** What a dry-run inspection found. No database was touched to produce it. */
export interface InspectResult {
  fileName: string;
  /** The status, row count and note that a commit of these bytes would record. */
  verdict: AttendanceVerdict;
  /** Fiscal months this file would re-fold. Empty for a rejected or rest-day file. */
  months: readonly AffectedMonth[];
  /** Distinct 出勤日期 in the file as ISO dates, ascending. */
  workDates: readonly string[];
}

/**
 * Folds a byte-level verdict plus the write's outcome into the shape finish() stores.
 *
 * `rowsStored` comes from the repository rather than from the verdict's `rowCount`: the
 * verdict states what the FILE holds, and the two must agree, but the audit trail has to
 * record what was actually written. Reporting the parsed count after a partial write would
 * put a number in import_log that no row in attendance_raw supports.
 */
function verdictOutcome(
  verdict: AttendanceVerdict,
  written: {
    rowsStored: number;
    months: readonly MonthRebuildResult[];
    supersededCount?: number;
    supersedeSkipped?: readonly string[];
  },
): Omit<IngestResult, "fileName" | "fileMtime" | "logId"> {
  // D-229: the sharp-drop guard fired, so rows HR removed are knowingly still counted.
  // The write itself succeeded, which is why this is PARTIAL and not FAILED - but it must
  // not be SUCCESS either, or the scheduler's exit code and the D-124 staleness banner
  // would both report the day as reconciled when it is not. Like the write-failure FAILED
  // above, this verdict cannot come from the pure classifier: whether a file is a sharp
  // drop depends on what is already stored, which the upload preview cannot know.
  const skipped = written.supersedeSkipped ?? [];
  const guardFired = skipped.length > 0;
  return {
    status: guardFired ? "PARTIAL" : verdict.status,
    rowsStored: written.rowsStored,
    months: written.months,
    problems: verdict.problems,
    // Not merged with verdict.errorMessage: boundary 1 means only a SUCCESS can reach the
    // supersede pass, and a SUCCESS always carries a null errorMessage. Rendered through
    // joinWarnings so the wording matches every other multi-message column.
    errorMessage: guardFired ? joinWarnings(skipped) : verdict.errorMessage,
    warnings: verdict.warnings,
    unexplainedZeroRatio: verdict.unexplainedZeroRatio,
    supersededCount: written.supersededCount ?? 0,
    categoryFilteredRows: verdict.categoryFilteredRows,
    isRestDay: verdict.isRestDay,
  };
}

/**
 * The outcome for a failure that is NOT a property of the file's bytes: an unreadable
 * path, a write that threw.
 *
 * A helper rather than the four near-identical literals it replaced, because every field
 * but the message is fixed by what FAILED means here - nothing was written, so no rows,
 * no months, and no completeness signal that would be honest to record.
 *
 * `unexplainedZeroRatio` is null even at the call site where a parse DID measure one (a
 * clean file whose write then threw). That measurement series is what will replace
 * D-222's single-day threshold, and it has to describe days that actually landed; a file
 * whose rows were rolled back would weight the calibration with hours nobody can read.
 */
function failedOutcome(
  errorMessage: string,
): Omit<IngestResult, "fileName" | "fileMtime" | "logId"> {
  return {
    status: "FAILED",
    rowsStored: 0,
    months: [],
    problems: [],
    errorMessage,
    warnings: [],
    unexplainedZeroRatio: null,
    supersededCount: 0,
    categoryFilteredRows: 0,
    isRestDay: false,
  };
}

/** Error -> a single line, without dragging a stack trace into a status panel. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : error.message;
  }
  return String(error);
}

/**
 * Appends the audit entry and folds it into the returned result.
 *
 * The log write is itself wrapped: if the database is unreachable, the caller still gets
 * a complete IngestResult describing what happened rather than an exception that erases
 * the diagnosis. `logId: null` is the marker for "this attempt is NOT in the audit table"
 * and the script exits non-zero on it.
 */
async function finish(
  source: Pick<AttendanceSource, "fileName" | "fileMtime" | "triggeredBy">,
  outcome: Omit<IngestResult, "fileName" | "fileMtime" | "logId">,
): Promise<IngestResult> {
  const base: Omit<IngestResult, "logId"> = {
    ...outcome,
    fileName: source.fileName,
    fileMtime: source.fileMtime,
  };
  try {
    const log = await appendImportLog({
      fileName: source.fileName,
      fileMtime: source.fileMtime,
      status: outcome.status,
      rowCount: outcome.rowsStored,
      errorMessage: outcome.errorMessage,
      // Joined rather than stored as JSON: this column is read straight into a status
      // panel, and there is exactly one warning today. A second one gets a separator, not
      // a schema change.
      warningMessage: joinWarnings(outcome.warnings),
      unexplainedZeroRatio: outcome.unexplainedZeroRatio,
      supersededCount: outcome.supersededCount,
      triggeredBy: source.triggeredBy,
    });
    return { ...base, logId: log.id };
  } catch (error) {
    console.error(
      `[ingest] ImportLog write failed for ${source.fileName}: ${describeError(error)}`,
    );
    return { ...base, logId: null };
  }
}

/**
 * Parses a workbook already in memory and reports what WOULD be recorded - no writes.
 *
 * This is the upload page's preview step. It shares classifyAttendanceParse() with the
 * commit below, so the status the operator approves is the status that gets stored; the
 * only outcome it cannot foresee is a FAILED caused by the write itself.
 *
 * `months` is derived from the parsed dates rather than from a rebuild, so a preview never
 * touches the database. It answers "which fiscal months will this file re-fold", which is
 * what the operator needs to see before approving a write that replaces those months.
 */
export function inspectAttendanceSource(
  source: Pick<AttendanceSource, "buffer" | "fileName">,
): InspectResult {
  const parsed = parseAttendanceFile(source.fileName, source.buffer);
  const verdict = classifyAttendanceParse(parsed);
  const months = parsed.ok ? affectedMonthsOf(parsed.parsed.rows) : [];
  const workDates = parsed.ok
    ? parsed.parsed.workDates.map((date) => formatDateOnly(date))
    : [];
  return { fileName: source.fileName, verdict, months, workDates };
}

/**
 * Parses a workbook already in memory, stores it, and logs the attempt.
 *
 * The status comes from classifyAttendanceParse() - see verdict.ts for why FAILED /
 * PARTIAL / SUCCESS are assigned the way they are, including D-170's rule that a
 * totals-row-only file is a SUCCESS with zero rows rather than a failed import.
 *
 * The one verdict decided HERE is the FAILED that a failed write produces: that is not a
 * property of the file, so it cannot live in the pure classifier. importAttendanceRows
 * wraps its upserts in a transaction and resolves every FiscalYear BEFORE writing, so a
 * missing financial year fails with nothing stored.
 *
 * A rest-day report is logged (SUCCESS / rowCount 0) without calling the repository at all.
 * importAttendanceRows would return `{rowsStored: 0, months: []}` for an empty array
 * anyway, but skipping it keeps a weekend upload from opening a write transaction that has
 * nothing to write.
 */
export async function ingestAttendanceSource(
  source: AttendanceSource,
): Promise<IngestResult> {
  const parsed = parseAttendanceFile(source.fileName, source.buffer);
  const verdict = classifyAttendanceParse(parsed);

  if (!parsed.ok) {
    return finish(source, verdictOutcome(verdict, { rowsStored: 0, months: [] }));
  }

  if (verdict.isRestDay) {
    return finish(source, verdictOutcome(verdict, { rowsStored: 0, months: [] }));
  }

  try {
    const result = await importAttendanceRows(
      parsed.parsed.rows,
      source.fileName,
      new Date(),
      {
        // D-229 boundary 1: only a clean parse may supersede. A PARTIAL file is missing
        // rows for reasons we could not explain, so treating it as the day's authoritative
        // snapshot would delete real hours on the strength of a file we already distrust.
        supersedeMissing: verdict.status === "SUCCESS",
      },
    );
    return finish(source, verdictOutcome(verdict, result));
  } catch (error) {
    return finish(source, failedOutcome(`入库失败：${describeError(error)}`));
  }
}

/**
 * Reads one workbook from disk and ingests it.
 *
 * The stat comes first and its failure is reported separately from the read's, because
 * ImportLog.fileMtime exists to tell "HR has not published today's file yet" (ENOENT)
 * apart from "the file is there but unreadable" (permissions, a partial write, a network
 * share that dropped). Both are FAILED, but they demand different human action, and the
 * D-124 staleness banner reads the stored errorMessage to say which one happened.
 *
 * Not the main path since D-170 - browser upload is. This stays for the bulk-backfill
 * bypass in scripts/fetch-attendance.ts, where the bytes come from a share, not a form.
 */
export async function ingestAttendanceFile(
  filePath: string,
  triggeredBy: ImportTrigger,
): Promise<IngestResult> {
  const fileName = basename(filePath);

  let fileMtime: Date | null = null;
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return finish(
        { fileName, fileMtime: null, triggeredBy },
        failedOutcome(`路径不是文件：${filePath}`),
      );
    }
    fileMtime = stats.mtime;
  } catch (error) {
    return finish(
      { fileName, fileMtime: null, triggeredBy },
      failedOutcome(`无法读取文件属性（文件可能尚未生成）：${describeError(error)}`),
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    return finish(
      { fileName, fileMtime, triggeredBy },
      failedOutcome(`文件存在但无法读取：${describeError(error)}`),
    );
  }

  return ingestAttendanceSource({ buffer, fileName, fileMtime, triggeredBy });
}

/** What a directory sweep did, so the caller can report it without re-listing. */
export interface DirectoryScanResult {
  /** Absolute or caller-supplied directory that was swept. */
  directory: string;
  /** Workbooks present, in name order. */
  candidates: readonly string[];
  /** Names skipped because import_log already holds a SUCCESS/PARTIAL for them (D-123). */
  skipped: readonly string[];
  /** One result per file actually ingested, in the order attempted. */
  results: readonly IngestResult[];
  /** Set when the directory itself could not be listed. No ImportLog row is written. */
  errorMessage: string | null;
}

/** True for a real attendance report, excluding Excel's `~$` lock files. */
function isWorkbookName(name: string): boolean {
  if (name.startsWith(LOCK_FILE_PREFIX)) return false;
  const lower = name.toLowerCase();
  return ATTENDANCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Sweeps a source directory (D-120's 目录 A) and ingests every not-yet-imported workbook.
 *
 * Files already logged as SUCCESS or PARTIAL are skipped - that is D-123's idempotence
 * clause, and without it every sweep would re-fold every month it has ever seen.
 * Re-importing a corrected file is still possible (D-122 makes the upsert idempotent);
 * it is just an explicit `retry` on a named file rather than something a sweep decides.
 *
 * A directory that cannot be listed does NOT write an ImportLog row: there is no file
 * name to attribute it to, and inventing one ("<目录不可达>") would put a non-existent
 * file into the provenance trail. The condition is returned to the caller, which is what
 * exits non-zero so the operator running the backfill notices.
 *
 * The path is a parameter, never a constant: it names the HR share, which differs per
 * environment and is only known at deploy time (D-197), so it comes from the argument or
 * the environment rather than being compiled in.
 *
 * D-197 restored the scheduled sweep to being a ROUTINE entry point, twice a day (09:05 and
 * 15:05), superseding D-170's era when browser upload was the only one. D-230 then removed
 * the outer Shell's per-day success marker, which makes `hasSuccessfulImport` above the ONLY
 * thing standing between a repeated sweep and a re-import. It keys on the file name alone,
 * so the whole scheme rests on D-120's uniqueness promise - upheld today because HR's export
 * is named 日考勤数据yyMMdd_HHmm.csv and the HHmm differs between the two daily files.
 *
 * If that ever regresses to a fixed name, the afternoon file would be skipped as "already
 * imported": the corrections would be dropped silently and D-229's supersede would never
 * run. Nothing here would report it, which is exactly why it is written down.
 *
 * A guard was proposed for exactly that - narrow the candidate test from an extension
 * whitelist to the precise 日考勤数据yyMMdd_HHmm.csv shape - and was REJECTED in D-232.
 * Do not re-propose it. Two consequences are therefore accepted, deliberately:
 *   - Any same-extension file dropped into the share is a candidate. HR does not have to
 *     change anything for this to happen; someone adding one unrelated .csv is enough.
 *   - `hasSuccessfulImport` accepts only SUCCESS/PARTIAL, so a permanently bad file is
 *     retried on EVERY sweep and writes a fresh FAILED row each time. It never heals.
 *     The remedy is to delete the file from the share, not to change this code.
 */
export async function scanAttendanceDirectory(
  directory: string,
  triggeredBy: ImportTrigger,
): Promise<DirectoryScanResult> {
  let names: string[];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && isWorkbookName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch (error) {
    return {
      directory,
      candidates: [],
      skipped: [],
      results: [],
      errorMessage: `目录不可访问：${describeError(error)}`,
    };
  }

  const skipped: string[] = [];
  const results: IngestResult[] = [];
  for (const name of names) {
    if (await hasSuccessfulImport(name)) {
      skipped.push(name);
      continue;
    }
    results.push(await ingestAttendanceFile(join(directory, name), triggeredBy));
  }

  return { directory, candidates: names, skipped, results, errorMessage: null };
}
