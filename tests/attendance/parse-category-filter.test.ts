// D-103's 员工类别 filter: which rows enter the system at all.
//
// This is the only test file that asserts the filter itself, and it is deliberately split
// across the two layers, because the two halves fail in different ways:
//
//   - the parser half (counting) - does the whitelist keep exactly 管理职 and 管间人员, and
//     is the removal recorded separately from droppedRows?
//   - the verdict half (reporting) - does a fully-filtered file get told apart from a
//     genuine rest day, and does an unknown category surface as a warning?
//
// Why it exists: before this filter, 397 of 577 rows in one real day carried 直接人员, worth
// 3032 of 4436 personnel hours. Those hours were stored as 管间工时 实绩, roughly tripling
// the number and silently eating D-141's 剩余. The file parsed cleanly and reported SUCCESS
// the whole time, which is why a passing import is not evidence and these tests are.
//
// The real 日考勤数据 export is NOT a fixture - it carries employee numbers and names.

import { describe, expect, it } from "vitest";

import { csv, FULL_HEADER, withNo, type Overrides } from "../helpers/attendance-csv";
import { parseAttendanceCsvFile } from "@/lib/attendance/parser";
import { classifyAttendanceParse } from "@/lib/attendance/verdict";

/** The blank-工号 totals row HR's export ends every day with. */
const TOTALS_ROW: Overrides = { 工号: "", 姓名: "", 上班时数: "4188.0000", 请假时间: "412.0000" };

function parsedOf(file: Buffer) {
  const result = parseAttendanceCsvFile(file);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`fixture did not parse: ${result.problems.map((p) => p.message).join("; ")}`);
  }
  return result.parsed;
}

function verdictOf(file: Buffer) {
  return classifyAttendanceParse(parseAttendanceCsvFile(file));
}

describe("parseAttendanceCsvFile - 人员类别过滤 (D-103)", () => {
  it("keeps both whitelisted categories and drops the rest", () => {
    // The three-category mix is the real shape of a day: HR exports the whole plant, and
    // this system counts the two 管间 categories out of it.
    const parsed = parsedOf(
      csv(FULL_HEADER, [
        withNo(1, { 员工类别: "管理职" }),
        withNo(2, { 员工类别: "管间人员" }),
        withNo(3, { 员工类别: "直接人员" }),
        withNo(4, { 员工类别: "直接人员" }),
      ]),
    );

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.categoryFilter.removedRows).toBe(2);
    expect(parsed.categoryFilter.unexpectedCategories.size).toBe(0);
  });

  it("drops 直接人员 without warning", () => {
    // Silence is the point. 直接人员 is about two thirds of every healthy file, so warning
    // on it would put a banner on every normal day and train the operator to dismiss it -
    // which would cost the unknown-category warning below its only reader.
    const verdict = verdictOf(
      csv(FULL_HEADER, [withNo(1), withNo(2, { 员工类别: "直接人员" })]),
    );

    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.categoryFilteredRows).toBe(1);
    expect(verdict.warnings).toEqual([]);
  });

  it("does not leak filtered rows into droppedRows", () => {
    // The regression this guards: droppedRows beyond the totals row means "rows lost to a
    // missing 工号", and any surplus turns the import PARTIAL with that reason attached.
    // Had the filter reused that counter, every healthy day would report PARTIAL with a
    // false explanation - a correct filter presenting itself as a data fault.
    const verdict = verdictOf(
      csv(FULL_HEADER, [
        withNo(1),
        withNo(2, { 员工类别: "直接人员" }),
        withNo(3, { 员工类别: "直接人员" }),
        withNo(4, { 员工类别: "直接人员" }),
      ]),
    );

    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.rowCount).toBe(1);
    expect(verdict.categoryFilteredRows).toBe(3);
    expect(verdict.extraDroppedRows).toBe(0);
    expect(verdict.errorMessage).toBeNull();
  });

  it("warns when a category nobody has ruled on appears", () => {
    // A known exclusion is a decision; an unknown one is a gap. If HR renames 管间人员 or
    // adds a category, the whitelist stops counting those people and the import still
    // reports a plausible row count - clean-looking data quietly missing staff.
    const verdict = verdictOf(
      csv(FULL_HEADER, [withNo(1), withNo(2, { 员工类别: "技术员" })]),
    );

    expect(verdict.status).toBe("SUCCESS");
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("发现未登记的人员类别：技术员 1 行");
  });

  it("renders a blank 员工类别 as （空白）rather than an empty gap", () => {
    // An empty cell must not produce "未登记的人员类别： 1 行" - the operator would read
    // that as a rendering bug and stop trusting the banner instead of checking the export.
    const verdict = verdictOf(csv(FULL_HEADER, [withNo(1), withNo(2, { 员工类别: "" })]));

    expect(verdict.warnings[0]).toContain("发现未登记的人员类别：（空白） 1 行");
  });

  it("orders the unknown categories by count, then by name", () => {
    // Deterministic on purpose. Insertion order would follow the row order in the sheet,
    // so HR reordering the export would reshuffle the sentence and break this assertion
    // without anything actually changing.
    const verdict = verdictOf(
      csv(FULL_HEADER, [
        withNo(1, { 员工类别: "乙类" }),
        withNo(2, { 员工类别: "技术员" }),
        withNo(3, { 员工类别: "技术员" }),
        withNo(4, { 员工类别: "甲类" }),
        withNo(5, { 员工类别: "技术员" }),
      ]),
    );

    // 技术员 first on count (3), then 乙类 before 甲类 on a code-point tie-break at 1 each.
    expect(verdict.warnings[0]).toContain("发现未登记的人员类别：技术员 3 行、乙类 1 行、甲类 1 行");
  });
});

describe("classifyAttendanceParse - 全部被过滤 vs 休日报表 (D-103 / D-170)", () => {
  it("reports a fully-filtered file as PARTIAL, not as a rest day", () => {
    // HR published a normal file; it just contained nobody this system counts. Labelling it
    // 休日报表 would hide a scope defect behind an ordinary Saturday, and D-170 treats a
    // rest day as positive evidence that the pipeline ran - evidence this file cannot give.
    const verdict = verdictOf(
      csv(FULL_HEADER, [
        withNo(1, { 员工类别: "直接人员" }),
        withNo(2, { 员工类别: "直接人员" }),
        TOTALS_ROW,
      ]),
    );

    expect(verdict.status).toBe("PARTIAL");
    expect(verdict.rowCount).toBe(0);
    expect(verdict.isRestDay).toBe(false);
    expect(verdict.categoryFilteredRows).toBe(2);
    expect(verdict.errorMessage).toContain("全部因人员类别");
  });

  it("still reports a genuine rest-day report as a rest day", () => {
    // The control for the case above: zero data rows AND zero filtered rows is the D-170
    // rest day. Without this pairing, the branch above could be satisfied by code that
    // simply stopped ever setting isRestDay.
    const verdict = verdictOf(csv(FULL_HEADER, [TOTALS_ROW]));

    expect(verdict.isRestDay).toBe(true);
    expect(verdict.categoryFilteredRows).toBe(0);
  });
});
