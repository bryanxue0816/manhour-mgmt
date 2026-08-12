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
  classifyAttendanceParse,
  summariseProblems,
} from "@/lib/attendance/verdict";
import type {
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

function parsed(rowCount: number, droppedRows: number): ParseAttendanceResult {
  return {
    ok: true,
    parsed: {
      rows: Array.from({ length: rowCount }, (_unused, i) => row(i + 2)),
      workDates: [new Date(Date.UTC(2026, 6, 1))],
      droppedRows,
    },
  };
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
