// The D-222 quality signals: what the parser MEASURES about a day's completeness.
//
// Separate from parse-verdict.test.ts on purpose. That file feeds hand-built signal
// literals into classifyAttendanceParse() and asserts the threshold and the wording; this
// one asserts the counting itself, from bytes. A threshold applied to a miscounted
// numerator is exactly as wrong as no threshold at all, and neither file can catch that
// alone.
//
// Why it matters: the failure this measures is HR exporting the daily report BEFORE the
// clock machines finish syncing. Measured on one real day, the same date early vs. final:
// 2820 h vs. 4010 h - 1190 h (29.7%) absent, with the file parsing cleanly, classifying
// SUCCESS, and carrying the right row count. Nothing else in the pipeline sees it.
//
// The CSV builder lives in tests/helpers/attendance-csv.ts, shared with the D-103 category
// filter tests. The real 日考勤数据 export is NOT a fixture - it carries employee numbers
// and names.

import { describe, expect, it } from "vitest";

import {
  csv,
  FULL_HEADER,
  REQUIRED,
  withNo,
  type Overrides,
} from "../helpers/attendance-csv";
import { parseAttendanceCsvFile } from "@/lib/attendance/parser";

/** One employee-day that is on roll, not on leave, and has no hours: the D-222 numerator. */
const ZERO_HOURS: Overrides = { 上班时数: ".0000" };

function signalsOf(file: Buffer) {
  const result = parseAttendanceCsvFile(file);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`fixture did not parse: ${result.problems.map((p) => p.message).join("; ")}`);
  }
  return result.parsed.qualitySignals;
}

describe("parseAttendanceCsvFile - 完整性信号 (D-222)", () => {
  it("counts on-roll, not-on-leave, zero-hour rows as unexplained", () => {
    const signals = signalsOf(
      csv(FULL_HEADER, [
        withNo(1),
        withNo(2, ZERO_HOURS),
        withNo(3, ZERO_HOURS),
        withNo(4, { 上班时数: "7.5000" }),
      ]),
    );

    expect(signals?.totalRows).toBe(4);
    expect(signals?.unexplainedZeroRows).toBe(2);
  });

  it("does not count a zero-hour row that 休假 explains", () => {
    // The whole point of the metric is UNEXPLAINED zeros. A day off is a zero everyone
    // already understands, and counting it would make every weekend look like a too-early
    // export - an alarm that fires on normal days gets ignored, which costs the signal.
    const signals = signalsOf(
      csv(FULL_HEADER, [withNo(1, { ...ZERO_HOURS, 是否休假: "是" }), withNo(2)]),
    );

    expect(signals?.totalRows).toBe(2);
    expect(signals?.unexplainedZeroRows).toBe(0);
  });

  it("does not count a zero-hour row that 请假时间 explains", () => {
    const signals = signalsOf(
      csv(FULL_HEADER, [withNo(1, { ...ZERO_HOURS, 请假时间: "8.0000" }), withNo(2)]),
    );

    expect(signals?.unexplainedZeroRows).toBe(0);
  });

  it("does not count a zero-hour row for someone no longer on roll", () => {
    // A left employee still appears in the export with zeros for the rest of the month.
    // Those zeros are permanent and expected; folding them in would put a floor under the
    // ratio that rises as the month goes on, and the threshold would drift with it.
    const signals = signalsOf(
      csv(FULL_HEADER, [withNo(1, { ...ZERO_HOURS, 在职: "否" }), withNo(2)]),
    );

    expect(signals?.unexplainedZeroRows).toBe(0);
  });

  it("shares the import's denominator: the dropped totals row is not counted", () => {
    // The blank-工号 totals row is dropped from `rows`, so it must be absent from
    // `totalRows` too. If the numerator and denominator came from different row sets the
    // ratio would be quietly wrong by one row in every single file.
    const signals = signalsOf(
      csv(FULL_HEADER, [
        withNo(1),
        withNo(2, ZERO_HOURS),
        { 工号: "", 姓名: "", 上班时数: "4188.0000", 请假时间: "412.0000" },
      ]),
    );

    expect(signals?.totalRows).toBe(2);
    expect(signals?.unexplainedZeroRows).toBe(1);
  });

  it("counts 无下班打卡记录 separately from the zero-hour rows", () => {
    // A corroborating signal, not part of the ratio: a half-synced machine tends to leave
    // clock-ins without clock-outs, so this number rising alongside the zeros is what
    // turns "suspicious" into "almost certainly a sync gap".
    const signals = signalsOf(
      csv(FULL_HEADER, [
        withNo(1, { 异常情况: "无下班打卡记录" }),
        withNo(2, { ...ZERO_HOURS, 异常情况: "无下班打卡记录" }),
        withNo(3, { 异常情况: "迟到" }),
      ]),
    );

    expect(signals?.noClockOutRows).toBe(2);
    expect(signals?.unexplainedZeroRows).toBe(1);
  });

  it("degrades to null when HR's export lacks 在职 or 是否休假", () => {
    // Must not fail the import: these columns are outside D-125's required list, and a
    // warning going quiet is a far cheaper failure than a day of hours refusing to load.
    const header = [...REQUIRED, "异常情况"] as const;
    const signals = signalsOf(csv(header, [withNo(1), withNo(2, ZERO_HOURS)]));

    expect(signals?.totalRows).toBe(2);
    expect(signals?.unexplainedZeroRows).toBeNull();
    expect(signals?.noClockOutRows).toBe(0);
  });

  it("degrades only 无下班打卡记录 to null when 异常情况 alone is missing", () => {
    const header = [...REQUIRED, "在职", "是否休假"] as const;
    const signals = signalsOf(csv(header, [withNo(1), withNo(2, ZERO_HOURS)]));

    expect(signals?.unexplainedZeroRows).toBe(1);
    expect(signals?.noClockOutRows).toBeNull();
  });

  it("reports no signals at all for a rest-day report with zero data rows", () => {
    // Null rather than a zero-row measurement, so nothing downstream can compute 0/0. A
    // NaN ratio compares false against the threshold, which would make the warning vanish
    // rather than misfire - quieter, and therefore worse to debug.
    const signals = signalsOf(
      csv(FULL_HEADER, [{ 工号: "", 姓名: "", 上班时数: ".0000", 请假时间: ".0000" }]),
    );

    expect(signals).toBeNull();
  });

  it("measures the too-early export it was built for", () => {
    // The shape of the real early snapshot: 156 of 180 kept rows on roll, not on leave,
    // no leave hours, and no work hours - 86.7%, against 3.6% in the final export of the
    // same day. Scaled down here; the ratio is what the verdict acts on.
    const rows: Overrides[] = [];
    for (let i = 0; i < 156; i += 1) {
      rows.push(withNo(i, { ...ZERO_HOURS, 异常情况: "无下班打卡记录" }));
    }
    for (let i = 156; i < 180; i += 1) {
      rows.push(withNo(i));
    }

    const signals = signalsOf(csv(FULL_HEADER, rows));

    expect(signals?.totalRows).toBe(180);
    expect(signals?.unexplainedZeroRows).toBe(156);
    expect(signals?.noClockOutRows).toBe(156);
  });
});
