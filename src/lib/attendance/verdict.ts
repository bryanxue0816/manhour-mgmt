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

import type {
  AttendanceProblem,
  AttendanceQualitySignals,
  CategoryFilterOutcome,
  ParseAttendanceResult,
} from "@/lib/attendance/parser";
import type { ImportStatus } from "@/lib/db/types";

/** How many parse problems are quoted into the stored error summary. */
const LOGGED_PROBLEM_LIMIT = 5;

/**
 * Blank-工号 rows a healthy file is expected to carry: exactly the 合计 totals row,
 * measured at grid index 576 of the real export. A second one means a real employee row
 * was skipped, which would under-report a section with no error anywhere - hence PARTIAL.
 */
export const EXPECTED_DROPPED_ROWS = 1;

/**
 * Share of unexplained zero-hour rows above which the day is flagged as possibly exported
 * too early (D-222).
 *
 * Calibration, and its limits. Measured on ONE real day, the same date exported twice:
 *
 *   | 指标                 | 最终导出 | 早期导出(推算全量) |
 *   |----------------------|---------:|-------------------:|
 *   | 未解释的零工时占比   |    3.6%  |             30.0%  |
 *   | 上班时数合计         |    4010  |              2820  |
 *
 * 10% sits ~3x above the healthy baseline and ~1/3 of the failure value. One day is not a
 * calibration set, which is why the measured ratio is written to import_log on EVERY
 * import: after ~2 weeks of real days the threshold gets tightened from that data instead
 * of from this single sample.
 *
 * Why not HR's own 是否异常 flag, which was this decision's first proposal at >50%? That
 * threshold is void. The early full-scope export measures 30.3% anomalous - it would not
 * have fired, while 1190 h (29.7%) were missing. And 人均工时(>0 行) is worse than useless
 * here: 7.89 vs 7.90 across the two states, because it averages only over people who
 * already have hours. Only a whole-population ratio can see this failure.
 */
export const UNEXPLAINED_ZERO_WARN_RATIO = 0.1;

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
  /**
   * Non-blocking notes about data that parsed fine but may not be COMPLETE (D-222).
   *
   * Separate from errorMessage on purpose. errorMessage's contract is "null on a clean
   * SUCCESS", and several places read non-null as "something went wrong"; a warning is
   * neither. 只告警不拦截 - status is never downgraded by anything in here, because the
   * rows are genuinely valid and re-importing the same day later simply overwrites them.
   */
  warnings: readonly string[];
  /**
   * Measured share of unexplained zero-hour rows, 0..1. Null when the file lacks the
   * columns to measure it, or holds no rows.
   *
   * Recorded on every import that lands, even when it is well under the threshold: the
   * threshold itself is calibrated from one day and has to be re-derived from this series.
   */
  unexplainedZeroRatio: number | null;
  /**
   * Rows the parser removed for being out of D-103's scope (员工类别 ∉ {管理职, 管间人员}).
   *
   * Held apart from droppedRows because the two mean opposite things to an operator:
   * droppedRows beyond the totals row is a fault, while this number is ~69% of every healthy
   * file and must be displayed as a normal, expected subtraction. The UI needs it so the
   * 行数 column can explain why 577 rows in the file became 180 rows in the database -
   * without it, a correct import looks like it lost two thirds of the data.
   */
  categoryFilteredRows: number;
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
 * Renders the warnings as the single line that gets both stored and displayed, or null
 * when the day looks complete.
 *
 * One function rather than a join at each call site, so the sentence the operator reads in
 * the upload preview is byte-identical to the one that lands in
 * `import_log.warning_message`. A preview that words the problem differently from the audit
 * trail is the same class of defect D-159 removed from the status path: two renderings of
 * one fact, drifting independently.
 */
export function joinWarnings(warnings: readonly string[]): string | null {
  return warnings.length === 0 ? null : warnings.join("；");
}

/** Percentage with one decimal, for a message a human reads. */
function asPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Turns the parser's measurements into the D-222 warning, or nothing.
 *
 * Returns the ratio alongside the text so the caller can store the measurement even on the
 * quiet days - that series is what will replace the single-day threshold.
 */
function assessCompleteness(signals: AttendanceQualitySignals | null): {
  warnings: string[];
  unexplainedZeroRatio: number | null;
} {
  if (signals === null || signals.unexplainedZeroRows === null) {
    // Either a rest-day report, or HR dropped 在职/是否休假. Degrading to "no warning" is
    // the deliberate choice: this feature must never be a reason an import fails.
    return { warnings: [], unexplainedZeroRatio: null };
  }

  // totalRows is documented as never 0 when signals is present, but this is the one place
  // a parser change could silently turn the ratio into NaN, and NaN < 0.1 is false - the
  // warning would vanish rather than misfire. Cheaper to guard than to rely on the invariant.
  if (signals.totalRows <= 0) {
    return { warnings: [], unexplainedZeroRatio: null };
  }

  const ratio = signals.unexplainedZeroRows / signals.totalRows;
  if (ratio < UNEXPLAINED_ZERO_WARN_RATIO) {
    return { warnings: [], unexplainedZeroRatio: ratio };
  }

  const clockOut =
    signals.noClockOutRows === null
      ? ""
      : `其中 ${String(signals.noClockOutRows)} 行被 HR 标记「无下班打卡记录」。`;
  return {
    warnings: [
      `疑似导出过早：${String(signals.totalRows)} 行中有 ` +
        `${String(signals.unexplainedZeroRows)} 行（${asPercent(ratio)}）在职、未休假、` +
        `未请假，但上班时数为 0（告警线 ${asPercent(UNEXPLAINED_ZERO_WARN_RATIO)}）。` +
        clockOut +
        "数据已入库，但很可能少了当天的工时；" +
        "请确认 HR 已完成打卡数据收集后重新导出并再次上传（同一天会覆盖，不会重复）。",
    ],
    unexplainedZeroRatio: ratio,
  };
}

/**
 * Warns when the file carried an employee category nobody has ruled on yet.
 *
 * Why this warns while 直接人员 - two thirds of every file - does not: a known excluded
 * category is a decision, an unknown one is a gap. If HR renames 管间人员 or adds a fourth
 * category, D-103's whitelist silently stops counting those people and the import still
 * reports SUCCESS with a plausible row count. That is exactly D-222's failure mode, one
 * layer up: clean-looking data that is quietly missing people. Warning on the expected
 * exclusion instead would fire on every healthy day and train the operator to ignore the
 * banner, costing the signal.
 *
 * 只告警不拦截: the kept rows are valid and re-importing the same day overwrites them, so a
 * renamed category costs a re-import, never a lost day.
 */
function assessCategoryFilter(filter: CategoryFilterOutcome): string[] {
  if (filter.unexpectedCategories.size === 0) {
    return [];
  }

  // Sorted by count then by name, NOT by the Map's insertion order - that order follows the
  // row order in the sheet, which would make the sentence (and its test) reshuffle whenever
  // HR reorders the export.
  const ordered = [...filter.unexpectedCategories.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : 1;
  });
  const listed = ordered
    .map(([name, count]) => `${name === "" ? "（空白）" : name} ${String(count)} 行`)
    .join("、");

  return [
    `发现未登记的人员类别：${listed}。` +
      "这些行未计入管间工时（仅统计管理职 / 管间人员）。" +
      "若 HR 新增或改名了人员类别，请先确认该类别是否应纳入统计，再重新导出上传。",
  ];
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
      warnings: [],
      unexplainedZeroRatio: null,
      categoryFilteredRows: 0,
    };
  }

  const { rows, droppedRows, categoryFilter, qualitySignals } = result.parsed;
  const extraDroppedRows = Math.max(0, droppedRows - EXPECTED_DROPPED_ROWS);
  const completeness = assessCompleteness(qualitySignals);
  // Order matters: the possibly-exported-too-early note is the more urgent of the two, and
  // joinWarnings renders them in array order into the one line the operator reads.
  const warnings = [...completeness.warnings, ...assessCategoryFilter(categoryFilter)];
  const unexplainedZeroRatio = completeness.unexplainedZeroRatio;
  const categoryFilteredRows = categoryFilter.removedRows;

  if (rows.length === 0) {
    if (categoryFilteredRows > 0) {
      // Every row was filtered out by D-103's 员工类别 filter. This is NOT a rest-day report
      // (D-170) - HR published a normal file, but this system only counts 管理职 and 管间人员,
      // and the file contained none of them. Keeping the two apart matters because a rest-day
      // file is positive evidence that HR published and the pipeline ran, whereas this file
      // is evidence that the export scope no longer matches what the system counts. Labelling
      // it 休日报表 would hide a scope defect behind an ordinary Saturday.
      return {
        status: "PARTIAL",
        rowCount: 0,
        errorMessage:
          `文件可解析，但 ${String(categoryFilteredRows)} 行全部因人员类别` +
          `不在统计范围内（仅统计管理职 / 管间人员）而被剔除，当日无管间工时数据。` +
          `请确认 HR 的导出范围是否包含管理职 / 管间人员。`,
        problems: [],
        droppedRows,
        extraDroppedRows,
        isRestDay: false,
        warnings,
        unexplainedZeroRatio,
        categoryFilteredRows,
      };
    }

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
      warnings,
      unexplainedZeroRatio,
      categoryFilteredRows,
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
      warnings,
      unexplainedZeroRatio,
      categoryFilteredRows,
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
    warnings,
    unexplainedZeroRatio,
    categoryFilteredRows,
  };
}
