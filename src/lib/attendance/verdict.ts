// The SUCCESS / PARTIAL / FAILED verdict for one attendance workbook, as a pure function.
//
// Extracted from ingest.ts for one reason: the upload page previews a file before writing
// it, and the preview must state the SAME verdict the commit will record. If the preview
// computed its own status, the two would drift - the operator would approve a file the
// panel calls 正常 and find PARTIAL in the audit trail, or worse the reverse. There is
// exactly one implementation and both paths call it.
//
// Deliberately free of prisma and node:fs. Everything here is decided by the bytes alone,
// which is also what makes the branches unit-testable without a database or an .xls
// fixture. The one verdict this module CANNOT produce is the FAILED that comes from a
// failed write - that is not a property of the file, and it stays in ingest.ts.

import type { AttendanceProblem, ParseAttendanceResult } from "@/lib/attendance/parser";
import type { ImportStatus } from "@/lib/db/types";

/** How many parse problems are quoted into the stored error summary. */
const LOGGED_PROBLEM_LIMIT = 5;

/**
 * Blank-工号 rows a healthy file is expected to carry: exactly the 合计 totals row,
 * measured at grid index 576 of the real export. A second one means a real employee row
 * was skipped, which would under-report a section with no error anywhere - hence PARTIAL.
 */
export const EXPECTED_DROPPED_ROWS = 1;

/** What one workbook's bytes say about how it should be recorded. */
export interface AttendanceVerdict {
  /** Status to record, on the assumption that the write itself succeeds. */
  status: ImportStatus;
  /** Rows that will be written. 0 for a rejected file and for a rest-day report. */
  rowCount: number;
  /**
   * Note stored in import_log.error_message. Null only when there is nothing to explain.
   *
   * Non-null on a SUCCESS rest-day report: an operator looking at a 0 in the 行数 column
   * needs to know it means "HR published nothing that day", not "the import lost the rows".
   */
  errorMessage: string | null;
  /** Parse problems. Non-empty only when the parser rejected the file. */
  problems: readonly AttendanceProblem[];
  /** Blank-工号 rows dropped by the parser. */
  droppedRows: number;
  /** Dropped rows beyond the expected totals row. Drives the PARTIAL branch. */
  extraDroppedRows: number;
  /**
   * A rest-day report: parsed cleanly and holds no employee rows (D-170).
   *
   * Distinct from `status === "SUCCESS" && rowCount === 0` as a display concept - the UI
   * must label this 休日报表 rather than show a bare zero that reads like data loss.
   */
  isRestDay: boolean;
}

/** Renders up to LOGGED_PROBLEM_LIMIT parse problems into one stored line. */
export function summariseProblems(problems: readonly AttendanceProblem[]): string {
  const shown = problems.slice(0, LOGGED_PROBLEM_LIMIT).map((p) => {
    return p.where === null ? p.message : `${p.where}：${p.message}`;
  });
  const rest = problems.length - shown.length;
  const tail = rest > 0 ? `；另有 ${String(rest)} 项问题` : "";
  return `解析失败：${shown.join("；")}${tail}`;
}

/**
 * Decides how a parsed workbook should be recorded.
 *
 * The three outcomes:
 *   * FAILED  - the parser rejected the file. Nothing is written.
 *   * PARTIAL - rows landed but more than the totals row was dropped for a blank 工号.
 *   * SUCCESS - rows landed and only the totals row was dropped, OR the file parsed
 *               cleanly with zero employee rows (a rest-day report).
 *
 * That last clause is D-170 and it reverses the earlier behaviour. HR publishes a report
 * on weekends and holidays too, and that report is a header plus a totals row - exactly
 * the shape this code used to call a failed import. An alarm that fires on ordinary
 * Saturdays trains the operator to ignore it, which costs the entire three-state health
 * signal that D-124 is built on. A rest-day file also legitimately resets D-124's
 * staleness clock: it is positive evidence that HR published and the pipeline ran.
 *
 * Unattributed hours do NOT appear here at all. 「默认全额计入 + 未归属可见告警」 makes them
 * an expected, measured condition (231 h over 35 rows on one real day) surfaced by the
 * /actuals banner; downgrading the status for the normal case would make the column
 * meaningless.
 */
export function classifyAttendanceParse(result: ParseAttendanceResult): AttendanceVerdict {
  if (!result.ok) {
    return {
      status: "FAILED",
      rowCount: 0,
      errorMessage: summariseProblems(result.problems),
      problems: result.problems,
      droppedRows: 0,
      extraDroppedRows: 0,
      isRestDay: false,
    };
  }

  const { rows, droppedRows } = result.parsed;
  const extraDroppedRows = Math.max(0, droppedRows - EXPECTED_DROPPED_ROWS);

  if (rows.length === 0) {
    // Reached only after the parser found no structural fault, so this really is an
    // empty-but-valid file rather than a broken one.
    return {
      status: "SUCCESS",
      rowCount: 0,
      errorMessage:
        `休日报表：文件可解析，但无员工数据行` +
        `（跳过 ${String(droppedRows)} 行无工号记录）。`,
      problems: [],
      droppedRows,
      extraDroppedRows,
      isRestDay: true,
    };
  }

  if (extraDroppedRows > 0) {
    return {
      status: "PARTIAL",
      rowCount: rows.length,
      errorMessage:
        `已入库 ${String(rows.length)} 行，` +
        `另有 ${String(extraDroppedRows)} 行因缺少工号被跳过` +
        `（正常仅应跳过 ${String(EXPECTED_DROPPED_ROWS)} 行合计行）。`,
      problems: [],
      droppedRows,
      extraDroppedRows,
      isRestDay: false,
    };
  }

  return {
    status: "SUCCESS",
    rowCount: rows.length,
    errorMessage: null,
    problems: [],
    droppedRows,
    extraDroppedRows,
    isRestDay: false,
  };
}
