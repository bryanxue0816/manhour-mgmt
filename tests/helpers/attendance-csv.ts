// A synthesised HR daily-attendance CSV, for parser tests that need real bytes.
//
// Extracted from parse-quality.test.ts once a second file needed the same fixture: the
// D-103 employee-category filter and the D-222 completeness signals are measured by the
// same parse, over the same 18 required columns, and two copies of this table would drift.
//
// The real 日考勤数据 export is NOT and must never become a fixture - it carries live
// 工号 and 姓名. Every row here is synthetic.
//
// Fixtures are UTF-8-with-BOM rather than GBK: the GBK table in csv.test.ts exists to prove
// the decoder handles HR's real encoding, which is not what these files are about.
//
// Not collected as a test file - vitest.config.mts only includes `tests/**/*.test.ts`.

/**
 * The 18 columns D-125 requires by name.
 *
 * A sheet missing any one of them is rejected before a single row is read, which is what
 * lets the D-103 filter use at("员工类别") rather than an optional lookup.
 */
export const REQUIRED = [
  "工号",
  "姓名",
  "部别",
  "课别",
  "职务",
  "员工类别",
  "出勤日期",
  "请假时间",
  "上班时数",
  "平时加班",
  "休日双倍",
  "节假加班",
  "休日调休",
  "调休假时数",
  "产假时数",
  "护理假时数",
  "流产假时数",
  "请假类别",
] as const;

/**
 * Columns the parser reads when present and degrades without.
 *
 * 在职 / 是否休假 / 异常情况 sit outside D-125 by design: mapHeader() indexes every column
 * present and validates only the required list, so HR dropping one weakens the D-222
 * warning instead of failing the import.
 */
export const OPTIONAL = ["在职", "是否休假", "异常情况"] as const;

export type ColumnName = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];

/**
 * One healthy in-scope employee-day. Every fixture row starts here.
 *
 * 员工类别 must stay a value in D-103's whitelist (管理职 / 管间人员). It is not decoration:
 * the parser drops every row outside that set, so flipping this default would silently
 * reduce every fixture in every file to zero rows.
 */
export const BASE: Readonly<Record<ColumnName, string>> = {
  工号: "100028",
  姓名: "张三",
  部别: "制造部",
  课别: "组立课",
  职务: "作业员",
  员工类别: "管间人员",
  出勤日期: "2026-08-25",
  请假时间: ".0000",
  上班时数: "8.0000",
  平时加班: ".0000",
  休日双倍: ".0000",
  节假加班: ".0000",
  休日调休: ".0000",
  调休假时数: ".0000",
  产假时数: ".0000",
  护理假时数: ".0000",
  流产假时数: ".0000",
  请假类别: "",
  在职: "是",
  是否休假: "否",
  异常情况: "",
};

/** Row overrides, keyed by column name. */
export type Overrides = Partial<Record<ColumnName, string>>;

/** Every column HR's real export carries, for the tests that need none of them absent. */
export const FULL_HEADER = [...REQUIRED, ...OPTIONAL] as const;

/**
 * Assembles a CSV over the given header, so a test can omit an optional column entirely.
 *
 * Column order is irrelevant to name-based mapping and these fixtures rely on that.
 *
 * The leading U+FEFF is a literal character and therefore invisible in an editor, but it is
 * load-bearing: it marks these bytes as UTF-8 so the decoder does not read them as GBK.
 * HR's real export is GBK with no BOM - that path is covered by csv.test.ts, not here.
 */
export function csv(header: readonly ColumnName[], rows: readonly Overrides[]): Buffer {
  const lines = [header.join(",")];
  // The decorative hyphen rule HR's SQL client draws under the header.
  lines.push(header.map(() => "----").join(","));
  for (const row of rows) {
    lines.push(header.map((name) => row[name] ?? BASE[name]).join(","));
  }
  lines.push(`(${String(rows.length)} 行受影响)`);
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

/** Distinct 工号 per row - a repeat within one day is a parse failure, not a signal. */
export function withNo(index: number, overrides: Overrides = {}): Overrides {
  return { 工号: `10${String(1000 + index)}`, ...overrides };
}
