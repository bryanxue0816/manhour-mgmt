// Excel plan-workbook parser (D-142 bulk import, D-151 field mapping).
//
// PORTED from tools/gen-fy26-constants.js, which has parsed the authoritative
// FY26工时计划.xlsx since Phase 0. Every structural invariant below is carried over
// verbatim, including the dual-path numeric cross-check. Three things had to change
// for a web upload, and they are the reason this is a port rather than an import:
//
//   1. The tool calls process.exit(1) on the first fault. An upload must report
//      EVERY fault at once - an administrator who fixes one broken cell per
//      round-trip through a 576-cell sheet will give up before the sheet is clean.
//   2. The tool reads a trusted file off disk with XLSX.readFile(). This reads an
//      untrusted buffer, so the sheet count, dimensions and row count are treated as
//      hostile input rather than as facts.
//   3. The tool emits TypeScript constants. This emits PlanUpsertInput rows, so the
//      import shares one write path and one validation layer with the edit grid.
//
// WHY THE STRICTNESS IS THE FEATURE: a spreadsheet that parses "successfully" into
// wrong numbers is the worst outcome this module can produce. Every plan number feeds
// the dashboard's 达成率 and the D-133 warning thresholds, and nothing downstream can
// tell a mistyped target from a real one. So this parser rejects anything it does not
// positively recognise - a rejected upload costs a re-export, an accepted-but-wrong
// upload costs a year of wrong reports.
//
// Deliberately NOT flexible: no column reordering, no fuzzy name matching, no
// tolerance for missing months. See matchPlanSections() and the EXPECTED_HEADER check.

import { read as readWorkbook, utils as xlsxUtils } from "xlsx";

import { FISCAL_MONTH_COUNT } from "@/lib/db/date";
import type { OrgSnapshot, PlanUpsertInput } from "@/lib/db/types";

import {
  assertNonNegativeHours,
  assertPlanYearComplete,
  validatePlanCell,
} from "./validate";

/** Columns before the 12 month columns: 部门 | 课名 | 目标工时分类. */
const LEAD_COLUMNS = 3;

/** Total column count the sheet must have, exactly. */
const COLUMN_COUNT = LEAD_COLUMNS + FISCAL_MONTH_COUNT;

/** Fiscal month headers in fiscal order - April first, March last (D-151). */
const MONTH_HEADERS = [
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
  "1月",
  "2月",
  "3月",
] as const;

/** The one header row this parser accepts, compared element-by-element. */
const EXPECTED_HEADER: readonly string[] = [
  "部门",
  "课名",
  "目标工时分类",
  ...MONTH_HEADERS,
];

/** The only two values 目标工时分类 may take (D-151). */
const CATEGORY_PLANNED = "计划";
const CATEGORY_CHALLENGE = "挑战";

/**
 * Separator for the (部门, 课名) composite key.
 *
 * U+001F (unit separator) rather than a printable character: a department or section
 * name containing the separator would otherwise let two different pairs collapse onto
 * one key, silently merging two sections' targets. No control character can appear in
 * a name that passed the org-table match.
 */
const KEY_SEP = "\u001F";

/**
 * Upper bound on data rows, checked before any per-row work.
 *
 * Not a business rule - a denial-of-service guard. sheet_to_json materialises the
 * whole grid, so a sheet claiming a million rows must be refused before it is walked.
 * Generous enough to describe any real org (128 sections x 2 categories).
 */
const MAX_DATA_ROWS = 256;

/** One problem found in the workbook, addressed to the person who must fix it. */
export interface ImportProblem {
  /** Excel cell or row reference (e.g. "D5", "第 5 行"), or null for whole-sheet faults. */
  where: string | null;
  message: string;
}

/** A parsed (部门, 课名) pair with its two 12-month series, before org matching. */
export interface ParsedPlanSection {
  dept: string;
  section: string;
  /** 12 values in fiscal order; index 0 = April. */
  planned: readonly number[];
  challenge: readonly number[];
}

export type ParsePlanWorkbookResult =
  | { ok: true; sections: readonly ParsedPlanSection[] }
  | { ok: false; problems: readonly ImportProblem[] };

export interface MatchedPlanRows {
  rows: readonly PlanUpsertInput[];
  /** Sections matched, for the preview header. */
  sectionCount: number;
}

export type MatchPlanSectionsResult =
  | { ok: true; matched: MatchedPlanRows }
  | { ok: false; problems: readonly ImportProblem[] };

/** Accumulates problems so one pass can report them all. */
class ProblemLog {
  private readonly problems: ImportProblem[] = [];

  add(where: string | null, message: string): void {
    this.problems.push({ where, message });
  }

  get length(): number {
    return this.problems.length;
  }

  /** Snapshot, capped so a pathological sheet cannot return 10k messages. */
  take(limit = 50): readonly ImportProblem[] {
    if (this.problems.length <= limit) {
      return [...this.problems];
    }
    return [
      ...this.problems.slice(0, limit),
      {
        where: null,
        message: `还有 ${this.problems.length - limit} 个问题未列出,请先修正以上问题。`,
      },
    ];
  }
}

/** Safe accessor for a possibly short row - a ragged grid must not throw. */
function cellOf(grid: readonly unknown[][], r: number, c: number): unknown {
  const row = grid[r];
  if (row === undefined) {
    return "";
  }
  const value = row[c];
  return value === undefined || value === null ? "" : value;
}

/** Trims the ends only; inner spaces are meaningful in Japanese-style names. */
function textOf(grid: readonly unknown[][], r: number, c: number): string {
  return String(cellOf(grid, r, c)).trim();
}

/** True when every column of the row within COLUMN_COUNT is blank. */
function isBlankRow(grid: readonly unknown[][], r: number): boolean {
  for (let c = 0; c < COLUMN_COUNT; c += 1) {
    if (textOf(grid, r, c) !== "") {
      return false;
    }
  }
  return true;
}

/** Excel-style cell address for an error message ("D5"). */
function cellRef(r: number, c: number): string {
  return xlsxUtils.encode_cell({ r, c });
}

interface NumericCell {
  value: number;
  /** Path A: the formatted display text, rounded. */
  a: number;
  /** Path B: the stored value, rounded. */
  b: number;
  dispText: string;
  rawValue: unknown;
  finite: boolean;
  /** False when the two paths round differently - see readNumericCell(). */
  agrees: boolean;
}

/**
 * Reads one numeric cell twice and requires the two readings to ROUND alike.
 *
 * Path A is the FORMATTED text Excel shows the administrator; path B is the value
 * actually stored in the file. The two routinely differ in the authoritative source:
 * 516 of its 576 cells store a fraction (1044.942857...) displayed as "1045", because
 * the targets were produced by dividing an annual budget. Sub-half divergence is
 * therefore NORMAL and must be accepted, or the real file would be unimportable.
 *
 * What this rejects is a display format that misrepresents the stored value by half an
 * hour or more - a cell storing 1200 but showing "1045". There the administrator
 * approving the preview and the number reaching the database would be different
 * figures, and no downstream check could notice.
 *
 * Both paths round because plan targets are stored as whole hours; rounding here is
 * the single place that decision is applied to an imported cell.
 */
function readNumericCell(
  disp: readonly unknown[][],
  raw: readonly unknown[][],
  r: number,
  c: number,
): NumericCell {
  const dispText = textOf(disp, r, c);
  const rawValue = cellOf(raw, r, c);

  const aNumber = dispText === "" ? Number.NaN : Number(dispText);
  const a = Number.isFinite(aNumber) ? Math.round(aNumber) : Number.NaN;

  const bNumber =
    typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
  const b = Number.isFinite(bNumber) ? Math.round(bNumber) : Number.NaN;

  const finite = Number.isFinite(a) && Number.isFinite(b);
  return {
    value: a,
    a,
    b,
    dispText,
    rawValue,
    finite,
    agrees: finite && a === b,
  };
}

/** Row shape after the numeric pass, before pairing. */
interface RawPlanRow {
  /** 1-based Excel row number, for error messages. */
  excelRow: number;
  dept: string;
  section: string;
  category: string;
  values: number[];
}

/**
 * Parses a plan workbook buffer into (部门, 课名) pairs of 12-month series.
 *
 * Enforces, in order: exactly one sheet; a non-empty range; the exact 15-column
 * header; no merged ranges; no blank rows; an even row count within bounds; a
 * finite, dual-path-agreeing, non-negative value in all 12 month columns of every
 * row; a 目标工时分类 drawn from {计划, 挑战}; and exactly one 计划 row and one 挑战
 * row per pair.
 *
 * Never throws for a malformed workbook - a corrupt file is an expected input here,
 * so every fault becomes a problem entry. Only a genuine bug throws.
 *
 * @param buffer raw bytes of an .xlsx file, already size-checked by the caller.
 */
export function parsePlanWorkbook(buffer: Buffer): ParsePlanWorkbookResult {
  const log = new ProblemLog();

  let workbook: ReturnType<typeof readWorkbook>;
  try {
    // cellFormula/cellHTML off: neither is read below, and not building them keeps
    // the parser away from the parts of the format with the most surface area.
    workbook = readWorkbook(buffer, {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
    });
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          where: null,
          message:
            "无法解析该文件,请确认它是未加密的 .xlsx 工作簿。" +
            `（解析器报告：${error instanceof Error ? error.message : String(error)}）`,
        },
      ],
    };
  }

  if (workbook.SheetNames.length !== 1) {
    return {
      ok: false,
      problems: [
        {
          where: null,
          message:
            `工作簿应只含 1 个工作表,实际 ${workbook.SheetNames.length} 个` +
            `（${workbook.SheetNames.join("、")}）。` +
            "多表工作簿无法确定该读哪一张,请删除多余工作表后重新上传。",
        },
      ],
    };
  }

  const sheetName = workbook.SheetNames[0] as string;
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined || sheet["!ref"] === undefined) {
    return {
      ok: false,
      problems: [{ where: null, message: `工作表「${sheetName}」是空的。` }],
    };
  }

  // Two readings of the same sheet - see readNumericCell() for why both are needed.
  const disp = xlsxUtils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  const raw = xlsxUtils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  // Bound the work before doing any of it. `disp.length` comes from the file's own
  // declared range, so it is untrusted input.
  if (disp.length - 1 > MAX_DATA_ROWS) {
    return {
      ok: false,
      problems: [
        {
          where: null,
          message:
            `数据行数 ${disp.length - 1} 超过上限 ${MAX_DATA_ROWS},已拒绝解析。` +
            "请确认上传的是计划工时表而非其它文件。",
        },
      ],
    };
  }

  const header: string[] = [];
  for (let c = 0; c < COLUMN_COUNT; c += 1) {
    header.push(textOf(disp, 0, c));
  }
  if (header.join("|") !== EXPECTED_HEADER.join("|")) {
    // Fatal on its own: every subsequent check reads columns by position, so a
    // shifted header would make all of them report nonsense.
    return {
      ok: false,
      problems: [
        {
          where: "第 1 行",
          message:
            "表头不符合 D-151 模板。应为：" +
            `[${EXPECTED_HEADER.join(", ")}]；实际为：[${header.join(", ")}]。` +
            "列顺序与名称必须完全一致（不支持调换列序或改名）。",
        },
      ],
    };
  }

  const merges = sheet["!merges"] ?? [];
  if (merges.length > 0) {
    // A merged range makes one value appear to belong to several sections. Rather
    // than guess which, refuse: unmerging in Excel is a two-click fix.
    log.add(
      null,
      `工作表含 ${merges.length} 个合并单元格,应为 0 个。` +
        "合并单元格会使同一个数值归属不明,请取消合并后重新上传。",
    );
  }

  const rows: RawPlanRow[] = [];
  for (let r = 1; r < disp.length; r += 1) {
    if (isBlankRow(disp, r)) {
      // Not skipped silently: a blank row usually means rows were deleted by
      // clearing contents, which leaves the count right and the data wrong.
      log.add(`第 ${r + 1} 行`, "存在空行,请删除整行（而非清空内容）后重新上传。");
      continue;
    }

    const values: number[] = [];
    for (let m = 0; m < FISCAL_MONTH_COUNT; m += 1) {
      const c = LEAD_COLUMNS + m;
      const parsed = readNumericCell(disp, raw, r, c);
      if (!parsed.finite) {
        log.add(
          cellRef(r, c),
          `不是有效数字（显示值 "${parsed.dispText}"）。` +
            "12 个月份列必须都填写数值,不能留空或填文字。",
        );
      } else if (!parsed.agrees) {
        log.add(
          cellRef(r, c),
          `显示值与存储值不一致：显示 "${parsed.dispText}" 取整为 ${parsed.a},` +
            `而实际存储值 ${String(parsed.rawValue)} 取整为 ${parsed.b}。` +
            "无法确定应采用哪一个,请去掉该单元格的显示格式后重新上传。",
        );
      } else {
        try {
          // Shares the edit grid's guard rather than re-testing >= 0 here, so an
          // upload and a keystroke can never disagree about what is storable.
          assertNonNegativeHours("plannedHours", parsed.value);
        } catch {
          log.add(cellRef(r, c), `工时目标不能为负数（${parsed.value}）。`);
        }
      }
      values.push(parsed.value);
    }

    rows.push({
      excelRow: r + 1,
      dept: textOf(disp, r, 0),
      section: textOf(disp, r, 1),
      category: textOf(disp, r, 2),
      values,
    });
  }

  if (rows.length === 0) {
    log.add(null, "表头之后没有任何数据行。");
  } else if (rows.length % 2 !== 0) {
    // Every section needs both a 计划 and a 挑战 row, so an odd count guarantees an
    // incomplete pair. Reported here because it localises better than 24 pair errors.
    log.add(
      null,
      `数据行数 ${rows.length} 为奇数。每个课应有 2 行（计划 + 挑战）,请检查是否漏行。`,
    );
  }

  for (const row of rows) {
    if (row.dept === "") {
      log.add(`第 ${row.excelRow} 行`, "部门为空。");
    }
    if (row.section === "") {
      log.add(`第 ${row.excelRow} 行`, "课名为空。");
    }
    if (row.category !== CATEGORY_PLANNED && row.category !== CATEGORY_CHALLENGE) {
      log.add(
        `第 ${row.excelRow} 行`,
        `目标工时分类为「${row.category}」,只能是「${CATEGORY_PLANNED}」或「${CATEGORY_CHALLENGE}」。`,
      );
    }
  }

  // Pair the two categories of each section, preserving first-seen order so the
  // preview lists sections in spreadsheet order rather than a hash order.
  interface PairEntry {
    dept: string;
    section: string;
    planned: number[] | null;
    challenge: number[] | null;
    rowCount: number;
  }
  const order: string[] = [];
  const byKey = new Map<string, PairEntry>();

  for (const row of rows) {
    const key = `${row.dept}${KEY_SEP}${row.section}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        dept: row.dept,
        section: row.section,
        planned: null,
        challenge: null,
        rowCount: 0,
      };
      byKey.set(key, entry);
      order.push(key);
    }
    entry.rowCount += 1;

    if (row.category === CATEGORY_PLANNED) {
      if (entry.planned !== null) {
        log.add(
          `第 ${row.excelRow} 行`,
          `${row.dept}/${row.section} 有重复的「${CATEGORY_PLANNED}」行。`,
        );
      } else {
        entry.planned = row.values;
      }
    } else if (row.category === CATEGORY_CHALLENGE) {
      if (entry.challenge !== null) {
        log.add(
          `第 ${row.excelRow} 行`,
          `${row.dept}/${row.section} 有重复的「${CATEGORY_CHALLENGE}」行。`,
        );
      } else {
        entry.challenge = row.values;
      }
    }
  }

  for (const key of order) {
    const entry = byKey.get(key) as PairEntry;
    if (entry.planned === null) {
      log.add(null, `${entry.dept}/${entry.section} 缺少「${CATEGORY_PLANNED}」行。`);
    }
    if (entry.challenge === null) {
      log.add(null, `${entry.dept}/${entry.section} 缺少「${CATEGORY_CHALLENGE}」行。`);
    }
    if (entry.rowCount !== 2) {
      log.add(
        null,
        `${entry.dept}/${entry.section} 有 ${entry.rowCount} 行,应为 2 行（计划 + 挑战）。`,
      );
    }
  }

  if (log.length > 0) {
    return { ok: false, problems: log.take() };
  }

  const sections: ParsedPlanSection[] = order.map((key) => {
    const entry = byKey.get(key) as PairEntry;
    // Non-null by the checks above; asserted rather than defaulted to [] so a future
    // reordering of those checks fails loudly instead of importing empty series.
    return {
      dept: entry.dept,
      section: entry.section,
      planned: entry.planned!,
      challenge: entry.challenge!,
    };
  });

  return { ok: true, sections };
}

/**
 * Resolves parsed (部门, 课名) pairs against the org master data (D-150).
 *
 * EXACT matching only, after end-trimming. No case folding, no width folding, no
 * fuzzy distance: 检查课 and 検査課 are different code points and the org table is
 * the authority on which one exists. A near-match that silently resolved to the
 * wrong section would post a whole year of targets to the wrong course, and nothing
 * downstream could detect it.
 *
 * Coverage is checked in BOTH directions. An unknown pair is an obvious error; a
 * MISSING pair is the dangerous one, because a partial import leaves the year at
 * fewer than 288 rows and the dashboard reads absent months as zero targets - a
 * section would silently show full budget consumption.
 *
 * @param sections parsed pairs from parsePlanWorkbook()
 * @param snapshot org master data
 * @param fiscalYearId target year - not in the workbook, chosen by the admin (D-151)
 */
export function matchPlanSections(
  sections: readonly ParsedPlanSection[],
  snapshot: OrgSnapshot,
  fiscalYearId: string,
): MatchPlanSectionsResult {
  const log = new ProblemLog();

  const deptNameById = new Map(snapshot.departments.map((d) => [d.id, d.name]));
  const sectionIdByKey = new Map<string, string>();
  for (const section of snapshot.sections) {
    const deptName = deptNameById.get(section.departmentId);
    if (deptName === undefined) {
      // An orphaned section cannot be addressed by (部门, 课名) at all. The schema's
      // Restrict relation makes this unreachable; reported rather than skipped so it
      // cannot masquerade as a spreadsheet error.
      log.add(
        null,
        `主数据异常：课「${section.name}」的所属部门（id=${section.departmentId}）不存在,请先修正组织主数据。`,
      );
      continue;
    }
    sectionIdByKey.set(`${deptName}${KEY_SEP}${section.name}`, section.id);
  }

  const rows: PlanUpsertInput[] = [];
  const seenKeys = new Set<string>();

  for (const parsed of sections) {
    const key = `${parsed.dept}${KEY_SEP}${parsed.section}`;
    const sectionId = sectionIdByKey.get(key);
    if (sectionId === undefined) {
      log.add(
        null,
        `组织主数据中不存在「${parsed.dept} / ${parsed.section}」。` +
          "部门名与课名必须与组织结构表完全一致（不做近似匹配）。",
      );
      continue;
    }
    if (seenKeys.has(key)) {
      // parsePlanWorkbook() already dedupes by the same key, so this is unreachable
      // from a single sheet. Kept because the cost of being wrong is one section's
      // targets overwriting another's inside a single transaction.
      log.add(null, `「${parsed.dept} / ${parsed.section}」在表中出现了多次。`);
      continue;
    }
    seenKeys.add(key);

    for (let index = 0; index < FISCAL_MONTH_COUNT; index += 1) {
      const plannedHours = parsed.planned[index];
      const challengeHours = parsed.challenge[index];
      if (plannedHours === undefined || challengeHours === undefined) {
        log.add(
          null,
          `「${parsed.dept} / ${parsed.section}」缺少第 ${index + 1} 个月的数据。`,
        );
        continue;
      }
      rows.push({
        sectionId,
        fiscalYearId,
        // index 0 is April, and month 1 is April - the offset is the only conversion.
        month: index + 1,
        plannedHours,
        challengeHours,
      });
    }
  }

  // The missing-pair direction. Listing names rather than a count, because "少了 3 个课"
  // sends the administrator hunting through 24 rows.
  const missing: string[] = [];
  for (const section of snapshot.sections) {
    const deptName = deptNameById.get(section.departmentId);
    if (deptName === undefined) {
      continue;
    }
    const key = `${deptName}${KEY_SEP}${section.name}`;
    if (!seenKeys.has(key)) {
      missing.push(`${deptName} / ${section.name}`);
    }
  }
  if (missing.length > 0) {
    log.add(
      null,
      `以下 ${missing.length} 个课在表中缺失：${missing.join("、")}。` +
        "缺失的课在看板上会被读成 0 工时目标（显示为预算 100% 消耗）,因此必须齐全才能导入。",
    );
  }

  if (log.length > 0) {
    return { ok: false, problems: log.take() };
  }

  // Final gate: re-check the ASSEMBLED rows with the same two functions the edit grid
  // uses. Everything here was already checked cell-by-cell above, so this pass should
  // be silent - it exists because the assembly step (pairing, month offsetting,
  // section resolution) sits between those checks and the write, and a bug in it
  // would otherwise reach the database unchallenged. Cheap for 288 rows.
  const rowsBySection = new Map<string, PlanUpsertInput[]>();
  for (const row of rows) {
    const cellErrors = validatePlanCell(row);
    for (const cellError of cellErrors) {
      log.add(null, `内部校验失败（${cellError.field}）：${cellError.message}`);
    }
    const bucket = rowsBySection.get(row.sectionId);
    if (bucket === undefined) {
      rowsBySection.set(row.sectionId, [row]);
    } else {
      bucket.push(row);
    }
  }
  // forEach rather than for..of: the tsconfig target predates Map iteration.
  rowsBySection.forEach((sectionRows, sectionId) => {
    try {
      assertPlanYearComplete(sectionRows);
    } catch (error) {
      log.add(
        null,
        `课（id=${sectionId}）的 12 个月份不完整：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (log.length > 0) {
    return { ok: false, problems: log.take() };
  }

  return { ok: true, matched: { rows, sectionCount: seenKeys.size } };
}
