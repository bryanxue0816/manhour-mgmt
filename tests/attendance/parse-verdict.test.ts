// D-170's verdict reversal: a rest-day report is a SUCCESS with 0 rows, not a failed import.
//
// This is the correction the whole batch hangs on. parser.ts used to return ok:false for a
// workbook holding only a header and a totals row, and that is exactly the shape HR
// publishes on weekends and holidays - so the old behaviour raised an alarm every Saturday.
// An alarm that fires on ordinary Saturdays trains the operator to ignore it, which costs
// the entire three-state health signal D-124 is built on.
//
// The module under test is pure by design: the preview and the commit must state the SAME
// verdict, so there is one implementation and both call it. That also means these branches
// need no .xls fixture - a ParseAttendanceResult literal is the input.

import { describe, expect, it } from "vitest";

import {
  EXPECTED_DROPPED_ROWS,
  UNEXPLAINED_ZERO_WARN_RATIO,
  classifyAttendanceParse,
  summariseProblems,
} from "@/lib/attendance/verdict";
import type {
  AttendanceQualitySignals,
  CategoryFilterOutcome,
  ParseAttendanceResult,
  ParsedAttendanceRow,
} from "@/lib/attendance/parser";

/** One employee-day. Only the fields the verdict touches need to be meaningful. */
function row(excelRow: number): ParsedAttendanceRow {
  return {
    excelRow,
    employeeNo: `10${String(excelRow).padStart(3, "0")}`,
    employeeName: "张三",
    workDate: new Date(Date.UTC(2026, 6, 1)),
    hrDeptName: "制造部",
    hrSectionName: "検査课",
    jobTitle: "作业员",
    employeeCategory: "正式员工",
    leaveHours: 0,
    workHours: 8,
    normalOvertime: 0,
    restDayDouble: 0,
    holidayOvertime: 0,
    restDayCompensate: 0,
    compensatoryLeave: 0,
    maternityLeave: 0,
    nursingLeave: 0,
    miscarriageLeave: 0,
  };
}

function parsed(
  rowCount: number,
  droppedRows: number,
  qualitySignals: AttendanceQualitySignals | null = null,
  categoryFilter: CategoryFilterOutcome = { removedRows: 0, unexpectedCategories: new Map() },
): ParseAttendanceResult {
  return {
    ok: true,
    parsed: {
      rows: Array.from({ length: rowCount }, (_unused, i) => row(i + 2)),
      workDates: [new Date(Date.UTC(2026, 6, 1))],
      droppedRows,
      categoryFilter,
      qualitySignals,
    },
  };
}

/** Quality signals for `total` rows of which `zero` are unexplained zero-hour rows. */
function signals(
  total: number,
  zero: number | null,
  noClockOut: number | null = null,
): AttendanceQualitySignals {
  return { totalRows: total, unexplainedZeroRows: zero, noClockOutRows: noClockOut };
}

describe("classifyAttendanceParse - rest-day report (D-170)", () => {
  it("records a header-plus-totals workbook as SUCCESS with 0 rows", () => {
    const verdict = classifyAttendanceParse(parsed(0, EXPECTED_DROPPED_ROWS));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.rowCount).toBe(0);
    expect(verdict.isRestDay).toBe(true);
  });

  it("explains the zero rather than leaving a bare 0 in the 行数 column", () => {
    // An operator reading 0 needs to know it means "HR published nothing that day", not
    // "the import lost the rows". This is the one SUCCESS that carries an errorMessage.
    const verdict = classifyAttendanceParse(parsed(0, EXPECTED_DROPPED_ROWS));
    expect(verdict.errorMessage).not.toBeNull();
    expect(verdict.errorMessage).toContain("休日报表");
  });

  it("reports no problems - a rest day is not a fault", () => {
    const verdict = classifyAttendanceParse(parsed(0, EXPECTED_DROPPED_ROWS));
    expect(verdict.problems).toEqual([]);
  });

  it("stays SUCCESS even when several blank rows were dropped", () => {
    // A rest-day export can trail blank formatting rows. There is no employee data to be
    // missing, so extra drops cannot mean "a real row was skipped" here - the PARTIAL
    // reasoning simply does not apply, and firing it would resurrect the Saturday alarm.
    const verdict = classifyAttendanceParse(parsed(0, 4));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.isRestDay).toBe(true);
    expect(verdict.extraDroppedRows).toBe(3);
  });
});

describe("classifyAttendanceParse - normal workbook", () => {
  it("records a clean file as SUCCESS with no note", () => {
    const verdict = classifyAttendanceParse(parsed(575, EXPECTED_DROPPED_ROWS));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.rowCount).toBe(575);
    expect(verdict.errorMessage).toBeNull();
    expect(verdict.isRestDay).toBe(false);
    expect(verdict.extraDroppedRows).toBe(0);
  });

  it("tolerates a file with no totals row at all", () => {
    // droppedRows below the expected 1 is not a fault: nothing was lost. Math.max keeps
    // extraDroppedRows at 0 rather than letting a negative slip into the message.
    const verdict = classifyAttendanceParse(parsed(575, 0));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.extraDroppedRows).toBe(0);
  });

  it("downgrades to PARTIAL when a blank 工号 dropped more than the totals row", () => {
    // The failure this branch guards: rows land, no error is raised anywhere, and a
    // section is quietly under-reported because one employee row had no 工号.
    const verdict = classifyAttendanceParse(parsed(574, EXPECTED_DROPPED_ROWS + 1));
    expect(verdict.status).toBe("PARTIAL");
    expect(verdict.rowCount).toBe(574);
    expect(verdict.extraDroppedRows).toBe(1);
    expect(verdict.errorMessage).toContain("574");
    expect(verdict.errorMessage).toContain("缺少工号");
  });

  it("still reports the rows that DID land on a PARTIAL", () => {
    // PARTIAL is not a rollback. Reporting rowCount 0 here would tell the operator to
    // re-upload a file whose rows are already in the table.
    expect(classifyAttendanceParse(parsed(500, 6)).rowCount).toBe(500);
  });
});

describe("classifyAttendanceParse - rejected workbook", () => {
  const rejected: ParseAttendanceResult = {
    ok: false,
    problems: [
      { where: null, message: "缺少必需列：出勤日期" },
      { where: "R5", message: "上班时数不是数字" },
    ],
  };

  it("records FAILED with 0 rows and carries the problems through", () => {
    const verdict = classifyAttendanceParse(rejected);
    expect(verdict.status).toBe("FAILED");
    expect(verdict.rowCount).toBe(0);
    expect(verdict.problems).toHaveLength(2);
    expect(verdict.isRestDay).toBe(false);
  });

  it("never labels a rejection as a rest day", () => {
    // Both produce rowCount 0, and the UI branches on isRestDay to decide between
    // 「休日报表」 and 「解析失败」. Collapsing them would show a parse failure as a
    // normal Saturday.
    expect(classifyAttendanceParse(rejected).isRestDay).toBe(false);
  });

  it("summarises the problems into the stored note", () => {
    const verdict = classifyAttendanceParse(rejected);
    expect(verdict.errorMessage).toContain("解析失败");
    expect(verdict.errorMessage).toContain("出勤日期");
    expect(verdict.errorMessage).toContain("R5");
  });
});

describe("classifyAttendanceParse - 导出过早告警 (D-222)", () => {
  // The failure mode: HR exports the daily report before the clock machines finish
  // syncing. The file parses cleanly, classifies SUCCESS, carries the right row count -
  // and is simply missing hours. Measured on one real day: 2820 h vs 4010 h final, i.e.
  // 1190 h (29.7%) absent with no error anywhere. These branches are the only thing in
  // the pipeline that can see it.

  it("stays silent on a healthy day (3.6% measured on the real final export)", () => {
    const verdict = classifyAttendanceParse(parsed(577, 1, signals(577, 21, 7)));
    expect(verdict.warnings).toEqual([]);
    expect(verdict.status).toBe("SUCCESS");
  });

  it("warns on an early export (86.7% measured on the real early snapshot)", () => {
    const verdict = classifyAttendanceParse(parsed(180, 1, signals(180, 156, 144)));
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("疑似导出过早");
    expect(verdict.warnings[0]).toContain("156");
    expect(verdict.warnings[0]).toContain("86.7%");
  });

  it("warns on the 30% early full-scope export the old >50% 是否异常 rule would have missed", () => {
    // The overturned threshold, pinned as a test: an early FULL export measures 30.3%
    // anomalous by HR's own 是否异常 flag, so a >50% rule stays quiet while a third of the
    // day's hours are gone. This ratio sees it.
    expect(classifyAttendanceParse(parsed(577, 1, signals(577, 173, 151))).warnings).toHaveLength(1);
  });

  it("never downgrades the status - 只告警不拦截", () => {
    // The rows are genuinely valid, and re-uploading the same day overwrites them. A
    // FAILED here would throw away real hours to complain about the ones that are absent.
    const verdict = classifyAttendanceParse(parsed(180, 1, signals(180, 156)));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.rowCount).toBe(180);
  });

  it("keeps the warning out of errorMessage", () => {
    // errorMessage's contract is "null on a clean SUCCESS" and callers read non-null as
    // "something went wrong". A warning is neither, so it travels in its own field.
    expect(classifyAttendanceParse(parsed(180, 1, signals(180, 156))).errorMessage).toBeNull();
  });

  it("fires exactly at the threshold, not just above it", () => {
    const atThreshold = Math.round(500 * UNEXPLAINED_ZERO_WARN_RATIO);
    expect(classifyAttendanceParse(parsed(500, 1, signals(500, atThreshold))).warnings).toHaveLength(
      1,
    );
    expect(
      classifyAttendanceParse(parsed(500, 1, signals(500, atThreshold - 1))).warnings,
    ).toHaveLength(0);
  });

  it("records the measured ratio even on a quiet day", () => {
    // The threshold is calibrated from ONE day. This series is what replaces it, so the
    // measurement has to be stored whether or not it fired.
    const verdict = classifyAttendanceParse(parsed(200, 1, signals(200, 4)));
    expect(verdict.warnings).toEqual([]);
    expect(verdict.unexplainedZeroRatio).toBeCloseTo(0.02, 6);
  });

  it("degrades to no warning when HR drops 在职/是否休假 rather than failing the import", () => {
    // These columns are deliberately NOT in D-125's required list. A warning feature must
    // never be the reason a day's real hours are rejected.
    const verdict = classifyAttendanceParse(parsed(577, 1, signals(577, null, 151)));
    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.warnings).toEqual([]);
    expect(verdict.unexplainedZeroRatio).toBeNull();
  });

  it("omits the 无下班打卡记录 clause when 异常情况 is absent", () => {
    const verdict = classifyAttendanceParse(parsed(180, 1, signals(180, 156, null)));
    expect(verdict.warnings[0]).toContain("疑似导出过早");
    expect(verdict.warnings[0]).not.toContain("无下班打卡记录");
  });

  it("cannot divide by zero on a rest-day report", () => {
    // A rest day has no rows, so it has no denominator - and 0/0 would be NaN, which is
    // neither above nor below the threshold. The warning must be absent, not undefined.
    const verdict = classifyAttendanceParse(parsed(0, EXPECTED_DROPPED_ROWS));
    expect(verdict.isRestDay).toBe(true);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.unexplainedZeroRatio).toBeNull();
  });

  it("reports no warning on a rejected file", () => {
    const verdict = classifyAttendanceParse({
      ok: false,
      problems: [{ where: null, message: "缺少必需列：出勤日期" }],
    });
    expect(verdict.warnings).toEqual([]);
    expect(verdict.unexplainedZeroRatio).toBeNull();
  });

  it("still warns on a PARTIAL - the two conditions are independent", () => {
    // A file can both drop an employee row for a blank 工号 AND be exported too early.
    // Reporting only the first would send the operator chasing the wrong repair.
    const verdict = classifyAttendanceParse(parsed(179, 3, signals(179, 156)));
    expect(verdict.status).toBe("PARTIAL");
    expect(verdict.warnings).toHaveLength(1);
  });
});

describe("summariseProblems", () => {
  it("prefixes a located problem with its cell reference", () => {
    expect(summariseProblems([{ where: "R5", message: "格式错误" }])).toContain("R5：格式错误");
  });

  it("omits the cell prefix for a whole-sheet fault", () => {
    // Pinned as a whole string because the composition IS what is under test: a located
    // problem reads 「解析失败：R5：格式错误」 and an unlocated one must not gain an empty
    // 「：」 where the cell reference would have gone.
    expect(summariseProblems([{ where: null, message: "找不到工作表" }])).toBe(
      "解析失败：找不到工作表",
    );
  });

  it("quotes at most five problems and counts the rest", () => {
    // The summary lands in a TEXT column an operator reads in a table cell. Quoting all
    // of a pathological sheet's problems would push the actionable first few out of view.
    const problems = Array.from({ length: 9 }, (_unused, i) => ({
      where: `R${String(i + 2)}`,
      message: "格式错误",
    }));
    const summary = summariseProblems(problems);
    expect(summary).toContain("R2");
    expect(summary).toContain("R6");
    expect(summary).not.toContain("R7");
    expect(summary).toContain("另有 4 项问题");
  });

  it("adds no tail when exactly five problems are quoted", () => {
    const problems = Array.from({ length: 5 }, (_unused, i) => ({
      where: `R${String(i + 2)}`,
      message: "格式错误",
    }));
    expect(summariseProblems(problems)).not.toContain("另有");
  });
});
