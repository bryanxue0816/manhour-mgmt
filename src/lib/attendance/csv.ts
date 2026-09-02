// CSV intake for the HR 日勤务报表 (D-221): bytes to the same grid the .xls path builds.
//
// WHY THIS EXISTS: HR's export tool can only produce CSV. Without this module the daily
// attendance data has no intake path at all - manual upload rejects .csv loudly, and the
// shared-directory auto-fetch skips it SILENTLY, with no import_log row, which is
// indistinguishable from "HR never wrote a file that day".
//
// WHAT CSV COSTS US, stated plainly: checkWorkbookSignature() pairs extension with magic
// number on the principle that the extension states intent and the signature states fact.
// CSV has no magic number, so that defence is forfeited. It is replaced by a header
// assertion, which is strictly stronger - a magic number only proves "this is an Excel
// file", while the mandatory column names prove "this really is an attendance report".
//
// Three properties of the observed export drive the design:
//
//   1. GBK, no BOM. Encoding is DETECTED, never assumed, because UTF-8 Chinese byte
//      sequences are largely also valid GBK double-bytes: decoding UTF-8 as GBK yields
//      mojibake with no error at all. Strict UTF-8 first, GBK only as the fallback, and
//      strict UTF-8 does throw on GBK bytes - so misdetection is near-zero.
//   2. Comma-delimited, and the delimiter is NOT inferred from the data. 刷卡数据 is
//      semicolon-packed ("07:53;16:31;>>09:20;16:31;"), so any frequency-based guess
//      would be actively wrong. A semicolon-delimited export fails the header assertion
//      loudly instead, which is the right outcome and much simpler.
//   3. Two decorative rows: a hyphen rule under the header, and a "(N 行受影响)" tail.
//      The tail is not noise to be discarded - it is the file declaring its own row
//      count, so asserting it buys truncation detection for free. Today it is dropped
//      only BY ACCIDENT (one field -> blank 工号 -> mistaken for the totals row), which
//      is not a thing to rely on.
//
// The load-bearing invariant is that every data record's field count equals the header's.
// That single check catches a wrong delimiter, a mishandled quote, and an embedded
// newline from any cause, without needing to know which of them happened.

import type { AttendanceProblem } from "./parser";

/** The two columns whose presence proves the text decoded to something meaningful. */
const ANCHOR_COLUMNS = ["工号", "出勤日期"] as const;

/** Encodings this module can read. Detection order is significant; see decodeText(). */
export type CsvEncoding = "utf-8" | "gbk";

export type DecodeCsvResult =
  | {
      ok: true;
      /** Header row first, then data rows only - both decorative rows removed. */
      grid: string[][];
      encoding: CsvEncoding;
      /** Row count the file declared about itself, or null if it did not. */
      declaredRows: number | null;
    }
  | { ok: false; problems: AttendanceProblem[] };

function fail(message: string, where: string | null = null): DecodeCsvResult {
  return { ok: false, problems: [{ where, message }] };
}

/**
 * Decodes bytes to text, reporting which encoding was used.
 *
 * Strict UTF-8 is tried first and its failure is the whole detection signal: a GBK file
 * is almost certain to contain a byte sequence that is invalid UTF-8, whereas the reverse
 * test does not exist - GBK will "successfully" decode nearly anything into mojibake.
 * Getting this order backwards produces a file that imports without complaint and stores
 * garbled department names.
 *
 * Returns null when neither encoding works, which in practice means UTF-16 or a binary
 * file renamed to .csv.
 */
function decodeText(bytes: Uint8Array): { text: string; encoding: CsvEncoding } | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    // Not UTF-8. Fall through to GBK.
  }

  let gbk: TextDecoder;
  try {
    gbk = new TextDecoder("gbk", { fatal: true });
  } catch {
    // A Node built with small-icu has no GBK table. This is an infrastructure fault, not
    // a defect in the uploaded file, and it must not be reported as one - the whole point
    // of naming it separately is that "reinstall the runtime with full ICU" and "ask HR
    // to re-export" are completely different actions.
    throw new Error(
      "当前运行环境缺少 GBK 解码支持(Node 未包含完整 ICU),无法读取 HR 导出的 CSV。" +
        "这是服务器环境问题,不是文件问题。",
    );
  }

  try {
    return { text: gbk.decode(bytes), encoding: "gbk" };
  } catch {
    return null;
  }
}

/**
 * Splits CSV text into records, honouring RFC4180 quoting.
 *
 * A double quote opens a quoted field ONLY when the field is still empty. Without that
 * guard a single stray quote inside a name - "张三"" - would be read as an opening quote
 * and swallow every following line into one cell, after which the row-count check would
 * blame truncation for what is really a punctuation mark.
 *
 * Returns null when the text ends inside a quoted field, which means the file was cut off
 * mid-record.
 */
function splitRecords(text: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    return null;
  }
  // A trailing newline leaves nothing pending; anything else is a final record with no
  // line terminator, which is legal.
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

function isBlankRecord(record: readonly string[]): boolean {
  return record.every((field) => field.trim() === "");
}

/**
 * True for the hyphen rule the SQL client draws under the header.
 *
 * Checked positionally (only the record immediately after the header) rather than
 * anywhere in the file: a data row could in principle carry "----" in a text column, and
 * dropping it would lose an employee's day without saying so.
 */
function isSeparatorRecord(record: readonly string[]): boolean {
  const joined = record.join("");
  return joined.length > 0 && /^-+$/.test(joined);
}

/** Matches the client's self-declared row count, in either language setting. */
const AFFECTED_ROWS = /^\(\s*(\d+)\s*(?:行受影响|rows?\s+affected)\s*\)$/;

function declaredRowsOf(record: readonly string[]): number | null {
  if (record.length !== 1) {
    return null;
  }
  const match = AFFECTED_ROWS.exec((record[0] as string).trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Turns raw CSV bytes into the header-plus-data grid parseAttendanceWorkbook() builds
 * from a sheet, so the row-level logic downstream is shared verbatim between formats.
 *
 * Rejects, in order: an empty file; text that decodes as neither UTF-8 nor GBK; a file
 * cut off inside a quoted field; a header missing its anchor columns; any data record
 * whose field count differs from the header's; and a declared row count that disagrees
 * with the rows actually present.
 *
 * A header-only file is a SUCCESS with zero data rows - D-170 requires a rest-day report
 * to be a normal outcome, not a failed import.
 *
 * @throws when the runtime cannot construct a GBK decoder. That is an environment fault,
 *   deliberately not folded into the problem list.
 */
export function decodeAttendanceCsv(bytes: Uint8Array): DecodeCsvResult {
  if (bytes.length === 0) {
    return fail("文件是空的,没有可导入的数据。");
  }

  // A UTF-16 BOM is worth naming explicitly. Both encodings below would otherwise read
  // it as garbage and the operator would be told the columns are wrong, when the actual
  // fix is to re-export as UTF-8 or ANSI.
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    return fail(
      "文件编码是 UTF-16,本系统只支持 UTF-8 或 GBK(ANSI)。" +
        "请在导出时选择 UTF-8,或用记事本另存为 ANSI 后重新上传。",
    );
  }

  // Strip a UTF-8 BOM. Left in place it becomes part of the first header cell - "﻿工号"
  // - and the operator is told 工号 is missing from a file that plainly has it.
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;

  const decoded = decodeText(body);
  if (decoded === null) {
    return fail(
      "无法确定文件编码(既不是 UTF-8 也不是 GBK)。" +
        "请确认上传的是 HR 导出的 CSV 文本文件,而不是被改了扩展名的其他文件。",
    );
  }

  const records = splitRecords(decoded.text);
  if (records === null) {
    return fail(
      "文件在一个带引号的字段中间结束,说明内容不完整(常见于复制过程中被截断)。" +
        "请重新复制或重新导出该文件。",
    );
  }

  const nonBlank = records.filter((record) => !isBlankRecord(record));
  if (nonBlank.length === 0) {
    return fail("文件里没有任何内容。");
  }

  const header = nonBlank[0] as string[];
  const missingAnchors = ANCHOR_COLUMNS.filter((name) => !header.includes(name));
  if (missingAnchors.length > 0) {
    // Deliberately blames the encoding/format rather than the columns. Letting a garbled
    // header reach mapHeader() would produce "表头缺少必需列：工号、姓名、…" - a list of 18
    // names that are all actually present, sending the operator to look for a column
    // problem that does not exist.
    return fail(
      `表头未能识别(找不到 ${missingAnchors.join("、")} 列)。` +
        "这通常说明文件编码不是 UTF-8 或 GBK,或者分隔符不是逗号," +
        "也可能导出的不是日考勤报表。",
      "第 1 行",
    );
  }

  const grid: string[][] = [header];
  let declaredRows: number | null = null;

  for (let i = 1; i < nonBlank.length; i += 1) {
    const record = nonBlank[i] as string[];

    if (i === 1 && isSeparatorRecord(record)) {
      continue;
    }

    const declared = declaredRowsOf(record);
    if (declared !== null) {
      declaredRows = declared;
      continue;
    }

    if (record.length !== header.length) {
      return fail(
        `该行有 ${record.length} 列,表头有 ${header.length} 列,列数不一致。` +
          "这通常说明分隔符不是逗号,或某个字段里的引号/换行没有被正确转义。",
        `第 ${i + 1} 行`,
      );
    }

    grid.push(record);
  }

  const dataRows = grid.length - 1;
  if (declaredRows !== null && declaredRows !== dataRows) {
    // The file described itself and the description does not match. The realistic cause
    // is a truncated copy off the network share, which would otherwise import as a
    // smaller but entirely valid-looking day.
    return fail(
      `文件末尾声明 ${declaredRows} 行,实际只解析出 ${dataRows} 行数据。` +
        "文件可能在复制过程中被截断,请重新获取完整文件后再导入。",
    );
  }

  return { ok: true, grid, encoding: decoded.encoding, declaredRows };
}
