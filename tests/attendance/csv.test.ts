// The CSV intake path (D-221): HR's SQL-tool export into the same grid the .xls path feeds.
//
// Two layers are covered here, deliberately in one file:
//
//   1. decodeAttendanceCsv() - bytes to grid. Encoding detection, the two decorative rows
//      the SQL client writes, field-count integrity, and the row count the file declares
//      about itself.
//   2. parseAttendanceCsvFile() - the whole chain, asserting a CSV produces the SAME
//      ParsedAttendanceRow shape an .xls does. The text-date branch is exercised here
//      rather than as a unit, because "does a real export import correctly" is the
//      question that matters and a private-function test would not answer it.
//
// Fixtures are written as readable Chinese and encoded to GBK by inverting the platform
// decoder (gbkEncode below). The alternative - pasting hex blobs - would make every
// fixture unreviewable, and nobody would notice if one of them stopped meaning what its
// name says. The real 日考勤数据 export is NOT used as a fixture: it carries employee
// numbers and names, and a test fixture is the last place that should live.

import { describe, expect, it } from "vitest";

import { decodeAttendanceCsv } from "@/lib/attendance/csv";
import { parseAttendanceCsvFile } from "@/lib/attendance/parser";

/**
 * GBK encoder built by inverting the platform's GBK decoder.
 *
 * Node ships no GBK TextEncoder and the dependency policy rules out adding iconv for a
 * test helper. Walking the double-byte space once and recording char -> [lead, trail] is
 * exact by construction: it is the decoder's own table, read backwards.
 */
const gbkTable = ((): Map<string, [number, number]> => {
  const decoder = new TextDecoder("gbk");
  const table = new Map<string, [number, number]>();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) {
        continue;
      }
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if (char.length === 1 && char !== "�" && !table.has(char)) {
        table.set(char, [lead, trail]);
      }
    }
  }
  return table;
})();

function gbkEncode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const pair = gbkTable.get(char);
    if (pair === undefined) {
      throw new Error(`Test fixture uses a character GBK cannot represent: ${char}`);
    }
    bytes.push(pair[0], pair[1]);
  }
  return new Uint8Array(bytes);
}

function utf8Encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function withBom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(bytes, 3);
  return out;
}

/**
 * The 18 columns D-125 makes mandatory, in the order HR's export happens to use.
 *
 * The real file has 69; the extra 51 are ignored by name-based mapping, so reproducing
 * them here would add noise without adding coverage. Order is irrelevant to the parser
 * and the fixture relies on that.
 */
const HEADER = [
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

/** The decorative rule the SQL client draws under the header: every field a hyphen run. */
const SEPARATOR = HEADER.map((name) => "-".repeat(Math.min(name.length * 2, 8)));

/** One employee-day, numbers in the ".0000" shape SQL Server's client prints. */
function dataRow(
  employeeNo: string,
  overrides: Partial<Record<(typeof HEADER)[number], string>> = {},
): string[] {
  const base: Record<string, string> = {
    工号: employeeNo,
    姓名: "张三",
    部别: "制造部",
    课别: "组立课",
    职务: "作业员",
    员工类别: "管间人员",
    出勤日期: "2026-08-25 00:00:00.000",
    请假时间: ".0000",
    上班时数: "8.0000",
    平时加班: "2.5000",
    休日双倍: ".0000",
    节假加班: ".0000",
    休日调休: ".0000",
    调休假时数: ".0000",
    产假时数: ".0000",
    护理假时数: ".0000",
    流产假时数: ".0000",
    请假类别: "",
  };
  return HEADER.map((name) => overrides[name] ?? base[name] ?? "");
}

interface FileOptions {
  separator?: boolean;
  tail?: string | null;
  newline?: string;
}

/** Assembles a CSV exactly the way the observed export is shaped. */
function csvText(rows: readonly (readonly string[])[], options: FileOptions = {}): string {
  const { separator = true, tail = null, newline = "\r\n" } = options;
  const lines: string[] = [HEADER.join(",")];
  if (separator) {
    lines.push(SEPARATOR.join(","));
  }
  for (const row of rows) {
    lines.push(row.join(","));
  }
  if (tail !== null) {
    lines.push(tail);
  }
  return lines.join(newline) + newline;
}

function affected(count: number): string {
  return `(${String(count)} 行受影响)`;
}

describe("decodeAttendanceCsv", () => {
  it("reads a GBK export and reports the encoding it detected", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028"), dataRow("100029")], { tail: affected(2) }),
    );

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("gbk");
    // Header + 2 data rows: both decorative rows are gone.
    expect(result.grid).toHaveLength(3);
    expect(result.grid[0]?.[0]).toBe("工号");
    expect(result.grid[1]?.[0]).toBe("100028");
    expect(result.declaredRows).toBe(2);
  });

  it("reads a UTF-8 export without mistaking it for GBK", () => {
    // The trap this guards: UTF-8 Chinese byte sequences are mostly also valid GBK
    // double-bytes, so a hardcoded GBK decode would silently produce mojibake instead of
    // failing. Detection must try strict UTF-8 first.
    const bytes = utf8Encode(csvText([dataRow("100028")], { tail: affected(1) }));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("utf-8");
    expect(result.grid[1]?.[2]).toBe("制造部");
  });

  it("strips a UTF-8 BOM instead of gluing it onto the first column name", () => {
    // A leading BOM makes the first header cell "﻿工号", which mapHeader would report
    // as a missing 工号 column - an error message pointing at the wrong problem entirely.
    const bytes = withBom(utf8Encode(csvText([dataRow("100028")], { tail: affected(1) })));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid[0]?.[0]).toBe("工号");
  });

  it("accepts a file with no decorative rows at all", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028")], { separator: false, tail: null }),
    );

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid).toHaveLength(2);
    expect(result.declaredRows).toBeNull();
  });

  it("rejects a file whose declared row count disagrees with the rows present", () => {
    // The "(N 行受影响)" line is the file describing itself, so a mismatch means bytes were
    // lost in transit - a truncated copy off a network share is the realistic cause, and it
    // would otherwise import as a smaller but perfectly valid-looking day.
    const bytes = gbkEncode(
      csvText([dataRow("100028"), dataRow("100029")], { tail: affected(180) }),
    );

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.message.includes("180"))).toBe(true);
    expect(result.problems.some((p) => p.message.includes("2"))).toBe(true);
  });

  it("rejects a row whose field count differs from the header", () => {
    const short = dataRow("100029").slice(0, 10);
    const bytes = gbkEncode(csvText([dataRow("100028"), short]));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.where).toContain("4");
    expect(result.problems[0]?.message).toContain("列数");
  });

  it("blames the encoding, not the columns, when the header decodes to nonsense", () => {
    // Decoding GBK bytes as something else yields 18 unrecognisable names. Letting that
    // reach mapHeader would report "表头缺少必需列：工号、姓名、..." and send the operator
    // looking for a column problem that does not exist.
    const bytes = new Uint8Array([
      0xff, 0xfe, 0x00, 0x41, 0x00, 0x42, 0x00, 0x0a, 0x00, 0x43,
    ]);

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("编码");
  });

  it("treats a header-only file as an empty day rather than an error (D-170)", () => {
    const bytes = gbkEncode(csvText([], { tail: affected(0) }));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid).toHaveLength(1);
    expect(result.declaredRows).toBe(0);
  });

  it("rejects an empty file", () => {
    const result = decodeAttendanceCsv(new Uint8Array(0));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("空");
  });

  it("handles LF-only line endings", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028")], { tail: affected(1), newline: "\n" }),
    );

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid).toHaveLength(2);
  });

  it("keeps a quoted field containing a comma in one piece", () => {
    const row = dataRow("100028", { 姓名: '"李,四"' });
    const bytes = gbkEncode(csvText([row], { tail: affected(1) }));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid[1]?.[1]).toBe("李,四");
  });

  it("does not let a bare quote mid-field swallow the rest of the file", () => {
    // A quote that is not at the start of a field is data, not a delimiter. Treating it as
    // an opening quote would consume every following line into one cell, and the row count
    // check would then blame truncation for a stray punctuation mark.
    const row = dataRow("100028", { 姓名: '张三"' });
    const bytes = gbkEncode(csvText([row, dataRow("100029")], { tail: affected(2) }));

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grid).toHaveLength(3);
    expect(result.grid[1]?.[1]).toBe('张三"');
  });

  it("rejects a file that ends inside a quoted field", () => {
    // A copy off the network share cut short mid-record. Flushing the dangling field
    // instead would produce a short but structurally valid-looking day.
    const bytes = gbkEncode(HEADER.join(",") + '\r\n100028,"李四');

    const result = decodeAttendanceCsv(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("截断");
  });
});

describe("parseAttendanceCsvFile", () => {
  it("produces the same row shape the .xls path does", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028"), dataRow("100029", { 课别: "" })], {
        tail: affected(2),
      }),
    );

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.rows).toHaveLength(2);

    const [first, second] = result.parsed.rows;
    expect(first?.employeeNo).toBe("100028");
    expect(first?.employeeName).toBe("张三");
    expect(first?.hrDeptName).toBe("制造部");
    expect(first?.hrSectionName).toBe("组立课");
    // ".0000" and "8.0000" are what SQL Server's client prints; Number() already accepts
    // a leading decimal point, so these needed no special handling.
    expect(first?.leaveHours).toBe(0);
    expect(first?.workHours).toBe(8);
    expect(first?.normalOvertime).toBe(2.5);
    // An absent 课别 must become NULL, not "".
    expect(second?.hrSectionName).toBeNull();

    expect(result.parsed.workDates).toHaveLength(1);
    expect(result.parsed.workDates[0]?.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("accepts a text date whose time part is exactly midnight", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028", { 出勤日期: "2026-08-25" })], { tail: affected(1) }),
    );

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.workDates[0]?.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("rejects a text date carrying a real time of day", () => {
    // Same rule the Excel-serial branch enforces: dropping the time would make two
    // readings of "the same day" disagree by time zone, which is the trap lib/db/date.ts
    // documents at length.
    const bytes = gbkEncode(
      csvText([dataRow("100028", { 出勤日期: "2026-08-25 09:20:00.000" })], {
        tail: affected(1),
      }),
    );

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("时间");
  });

  it("rejects a calendar date that does not exist", () => {
    // Date.UTC(2026, 1, 30) silently becomes March 2nd. Without a round-trip check the row
    // would import against a day the operator never exported.
    const bytes = gbkEncode(
      csvText([dataRow("100028", { 出勤日期: "2026-02-30 00:00:00.000" })], {
        tail: affected(1),
      }),
    );

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("2026-02-30");
  });

  it("reports a missing mandatory column by name", () => {
    const text = csvText([dataRow("100028")], { tail: affected(1) })
      .split("\r\n")
      .map((line, index) => (index === 0 ? line.replace("上班时数", "上班时間") : line))
      .join("\r\n");

    const result = parseAttendanceCsvFile(Buffer.from(gbkEncode(text)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("上班时数");
  });

  it("treats a file with no employee rows as a rest-day report, not a failure (D-170)", () => {
    const bytes = gbkEncode(csvText([], { tail: affected(0) }));

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.rows).toHaveLength(0);
    expect(result.parsed.workDates).toHaveLength(0);
  });

  it("rejects the same employee twice on one day", () => {
    const bytes = gbkEncode(
      csvText([dataRow("100028"), dataRow("100028")], { tail: affected(2) }),
    );

    const result = parseAttendanceCsvFile(Buffer.from(bytes));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.message).toContain("100028");
  });
});
