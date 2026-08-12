// Attendance workbook parser: one day of the HR 日勤务报表 (D-120) into rows.
//
// Structurally a sibling of lib/plans/import.ts and it reuses that module's
// scaffolding on purpose - the same ProblemLog / cellOf / discriminated-union shape,
// so an administrator sees one error vocabulary across both uploads. What it does NOT
// reuse is that module's POLICY, and every divergence below is deliberate:
//
//   1. NO fixed header. The plan sheet is compared element-by-element against an
//      exact 15-column header; D-125 mandates the opposite here, because HR adds and
//      removes columns between quarters. Columns are located BY NAME, unknown extras
//      are ignored silently, and only a missing mandatory name is fatal.
//   2. MERGED CELLS ARE NOT BLANKET-REJECTED. The plan parser refuses a workbook with
//      any merge at all. The real attendance file has 5 - measured as A577:H577,
//      K577:Q577, T577:W577, BH577:BM577 and BO577:BQ577, all inside the totals row
//      that this parser drops anyway. Copying that gate would make the authentic file
//      unimportable, so the check is narrowed to merges that touch a row we KEEP
//      (where a merge really would leave covered cells reading blank, i.e. 0 hours).
//   3. NO DUAL-PATH ROUNDING. Plan cells are stored as fractions and displayed
//      rounded, so that parser reads each cell twice and rounds. Attendance hours are
//      authored in half-hour steps (8.5, 342.5); rounding them would corrupt the very
//      numbers D-104/D-105 consume, so the stored value is taken verbatim.
//   4. NO CROSS-FIELD VALIDATION, per D-113: HR is the authoritative master, and this
//      parser must not re-derive its arithmetic (e.g. "do the 假别 columns sum to
//      请假时间"). It validates STRUCTURE (D-125 column presence, cell types, key
//      uniqueness) and nothing about business meaning.
//
// The totals row is the one row that must never reach the database, and its only
// reliable discriminator is a blank 工号 - measured at grid index 576 carrying
// 请假时间 412 / 上班时数 4188, numbers that would double the plant's daily total if
// imported. Blank-工号 rows are therefore dropped and counted, never reported as
// faults.
//
// Deliberately NOT computed here: 人员工时 / 加班工时 (D-104/D-105) and the
// JobTitleRule exclusions (D-109). This module answers "what does the file say"; the
// formulas and the exclusion verdicts live in lib/attendance/calc.ts, so a change to
// either can be unit-tested without an .xls fixture.

import { read as readWorkbook, utils as xlsxUtils } from "xlsx";

import { assertCalendarDay } from "@/lib/db/date";

/** 出勤日期 - converted from an Excel serial, the sheet's only date column. */
const DATE_COLUMN = "出勤日期";

/** 工号 - the row identity, and the only discriminator for the totals row. */
const NO_COLUMN = "工号";

/** Verbatim text columns, read as-is with no interpretation. */
const TEXT_COLUMNS = [
  NO_COLUMN,
  "姓名",
  "部别",
  "课别",
  "职务",
  "员工类别",
] as const;

/**
 * Hour columns: header name -> field. These are exactly the 10 inputs D-104 and D-105
 * consume, and nothing else from the 69-column sheet is read.
 *
 * The two decoys D-105 warns about - 加班总时数 (AC) and 实际出勤加班时数 (AH) - are
 * absent by design. They sit next to these columns, carry similar names and a
 * different arithmetic, and picking one up would produce plausible wrong totals.
 */
const NUMERIC_COLUMNS = {
  请假时间: "leaveHours",
  上班时数: "workHours",
  平时加班: "normalOvertime",
  休日双倍: "restDayDouble",
  节假加班: "holidayOvertime",
  休日调休: "restDayCompensate",
  调休假时数: "compensatoryLeave",
  产假时数: "maternityLeave",
  护理假时数: "nursingLeave",
  流产假时数: "miscarriageLeave",
} as const;

/**
 * Mandatory by D-125 but never read.
 *
 * 请假类别 is a schema-version signal: D-113 forbids cross-checking it against
 * 请假时间, so its VALUE is of no use to this system, but its DISAPPEARANCE would mean
 * HR restructured the leave block - exactly the situation where the hour columns
 * around it must be re-verified by a human before the numbers are trusted.
 */
const PRESENCE_ONLY_COLUMNS = ["请假类别"] as const;

type NumericField = (typeof NUMERIC_COLUMNS)[keyof typeof NUMERIC_COLUMNS];

/**
 * Excel's day-zero for the 1900 date system, as a UTC instant.
 *
 * 1899-12-30 rather than 1899-12-31 because Excel treats 1900 as a leap year: the
 * off-by-one epoch absorbs the phantom 1900-02-29 for every date after it, which is
 * every date this system will ever see. Verified against the sample file: serial
 * 46204 -> 2026-07-01, fiscal month 4.
 */
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

const MS_PER_DAY = 86_400_000;

/**
 * Plausible range for an attendance serial (~1900-01-01 to ~2119).
 *
 * Not a business rule - a corrupt-cell guard. A stray large number in the date column
 * would otherwise become a Date in the year 4000 and land in a fiscal year nothing
 * queries, so the row would vanish from every report without any error.
 */
const MIN_DATE_SERIAL = 1;
const MAX_DATE_SERIAL = 80_000;

/**
 * Upper bound on grid rows, checked before any per-row work.
 *
 * A denial-of-service guard, not a business limit: sheet_to_json materialises the
 * whole grid, so a sheet claiming a million rows must be refused before it is walked.
 * The plan parser's 256 would reject the real attendance file outright (measured 577
 * grid rows / 575 data rows for one day); 8192 leaves room for a plant several times
 * this size, or a multi-day backfill.
 */
const MAX_GRID_ROWS = 8192;

/** One problem found in the workbook, addressed to the person who must fix it. */
export interface AttendanceProblem {
  /** Excel cell or row reference (e.g. "R5", "第 5 行"), or null for whole-sheet faults. */
  where: string | null;
  message: string;
}

/** One employee-day exactly as the file states it, before any formula is applied. */
export interface ParsedAttendanceRow {
  /** 1-based Excel row number, so a downstream fault can be traced to a cell. */
  excelRow: number;
  /** 工号, kept as a string: an Int would drop a leading zero if HR ever issues one. */
  employeeNo: string;
  employeeName: string | null;
  /** Calendar day at UTC midnight - already through assertCalendarDay(). */
  workDate: Date;
  /** 部别 verbatim. May be "" or the literal placeholder "（空）" that HR writes. */
  hrDeptName: string;
  /** 课别 verbatim; null for the 35 measured rows that carry none. */
  hrSectionName: string | null;
  jobTitle: string | null;
  employeeCategory: string | null;
  leaveHours: number;
  workHours: number;
  normalOvertime: number;
  restDayDouble: number;
  holidayOvertime: number;
  restDayCompensate: number;
  compensatoryLeave: number;
  maternityLeave: number;
  nursingLeave: number;
  miscarriageLeave: number;
}

export interface ParsedAttendance {
  /**
   * Employee-day rows, totals row excluded.
   *
   * MAY BE EMPTY, and an empty array is not an error (D-170): a rest-day report holds
   * a header and a totals row and nothing else. Callers must not treat `rows.length
   * === 0` as a parse failure - the parser would have returned ok:false for that.
   */
  rows: readonly ParsedAttendanceRow[];
  /**
   * Distinct 出勤日期 in the file, ascending.
   *
   * D-120 promises one day per file and the sample holds exactly one, but a multi-day
   * file is NOT rejected: the (工号, 出勤日期) upsert key makes a backfill of several
   * days perfectly well-defined, and refusing one would cost a code change at the
   * moment HR is trying to repair data. Callers that need the single-day assumption
   * (an ImportLog label, a month-scoped rebuild) read it from here instead.
   */
  workDates: readonly Date[];
  /** Blank-工号 rows dropped, i.e. the totals row - normally exactly 1. */
  droppedRows: number;
}

export type ParseAttendanceResult =
  | { ok: true; parsed: ParsedAttendance }
  | { ok: false; problems: readonly AttendanceProblem[] };

/** Accumulates problems so one pass can report them all. */
class ProblemLog {
  private readonly problems: AttendanceProblem[] = [];

  add(where: string | null, message: string): void {
    this.problems.push({ where, message });
  }

  get length(): number {
    return this.problems.length;
  }

  /** Snapshot, capped so a pathological sheet cannot return 10k messages. */
  take(limit = 50): readonly AttendanceProblem[] {
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

/** Trims the ends only; inner spaces are meaningful in these names. */
function textOf(grid: readonly unknown[][], r: number, c: number): string {
  return String(cellOf(grid, r, c)).trim();
}

/** Excel-style cell address for an error message ("R5"). */
function cellRef(r: number, c: number): string {
  return xlsxUtils.encode_cell({ r, c });
}

/** "" -> null, so an absent 课别/姓名 is storable as NULL rather than as "". */
function nullableText(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * Locates every mandatory column by header name, reporting all faults at once.
 *
 * Returns null when the header is unusable, having logged why. Duplicate names are
 * fatal rather than first-wins: two columns called 上班时数 mean the export is
 * ambiguous, and silently reading the left one is how a parser attributes hours to the
 * wrong measure with no visible symptom.
 */
function mapHeader(
  grid: readonly unknown[][],
  log: ProblemLog,
): Map<string, number> | null {
  const headerRow = grid[0] ?? [];
  const index = new Map<string, number>();
  const duplicates = new Set<string>();

  for (let c = 0; c < headerRow.length; c += 1) {
    const name = textOf(grid, 0, c);
    if (name === "") {
      continue;
    }
    if (index.has(name)) {
      duplicates.add(name);
      continue;
    }
    index.set(name, c);
  }

  const required = [
    ...TEXT_COLUMNS,
    DATE_COLUMN,
    ...Object.keys(NUMERIC_COLUMNS),
    ...PRESENCE_ONLY_COLUMNS,
  ];

  const missing = required.filter((name) => !index.has(name));
  const requiredDuplicates = required.filter((name) => duplicates.has(name));

  if (missing.length > 0) {
    log.add(
      "第 1 行",
      `表头缺少必需列：${missing.join("、")}。` +
        "本系统按列名匹配字段(D-125),列名变更需先在管理页更新映射表," +
        "在此之前不导入,以免把工时算到错误的字段上。",
    );
  }
  if (requiredDuplicates.length > 0) {
    log.add(
      "第 1 行",
      `表头存在重复列名：${requiredDuplicates.join("、")}。` +
        "重复列名无法确定该读哪一列,请删除多余列后重新导出。",
    );
  }

  return missing.length > 0 || requiredDuplicates.length > 0 ? null : index;
}

/**
 * Marks every grid row covered by a merged range.
 *
 * Only rows this parser KEEPS matter: xlsx stores a merged value in the top-left cell
 * and leaves the covered cells empty, so a merge across data rows would read as 0
 * hours for everyone but the first employee. The totals row's 5 measured merges are
 * harmless precisely because that row is dropped.
 */
function mergedRowFlags(
  merges: readonly { s: { r: number }; e: { r: number } }[],
  rowCount: number,
): boolean[] {
  const flags = new Array<boolean>(rowCount).fill(false);
  for (const merge of merges) {
    const from = Math.max(0, merge.s.r);
    const to = Math.min(rowCount - 1, merge.e.r);
    for (let r = from; r <= to; r += 1) {
      flags[r] = true;
    }
  }
  return flags;
}

/**
 * Reads one hour cell: blank means 0, anything non-numeric is a fault.
 *
 * Blank-as-zero is not leniency - the sheet leaves an employee's 产假时数 empty rather
 * than writing 0 for the 574 people who took no maternity leave that day.
 *
 * Negative values PASS. D-105 overtime is legally negative (a day using more 调休 than
 * it earns), and a clamp here would rewrite anomalous imports into plausible ones -
 * the exact failure mode lib/db/hours.ts exists to prevent.
 */
function readHourCell(
  grid: readonly unknown[][],
  r: number,
  c: number,
  columnName: string,
  log: ProblemLog,
): number {
  const value = cellOf(grid, r, c);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      log.add(
        cellRef(r, c),
        `${columnName} 不是有限数值。Infinity/NaN 会写入数据库并污染每一层汇总。`,
      );
      return 0;
    }
    return value;
  }

  const text = String(value).trim();
  if (text === "") {
    return 0;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    log.add(
      cellRef(r, c),
      `${columnName} 的值"${text}"不是数值。请在考勤系统中修正该单元格后重新导出。`,
    );
    return 0;
  }
  return parsed;
}

/**
 * Converts an Excel 1900 serial into a calendar day at UTC midnight.
 *
 * Returns null and logs when the cell is not a usable serial. A fractional serial is
 * rejected rather than truncated: it means the column carries a timestamp, and
 * silently dropping the time would make two readings of "the same day" disagree
 * depending on the reader's time zone - the trap lib/db/date.ts documents at length.
 */
function readDateCell(
  grid: readonly unknown[][],
  r: number,
  c: number,
  log: ProblemLog,
): Date | null {
  const value = cellOf(grid, r, c);
  const serial = typeof value === "number" ? value : Number(String(value).trim());

  if (String(value).trim() === "" || !Number.isFinite(serial)) {
    log.add(
      cellRef(r, c),
      `${DATE_COLUMN} 为空或不是日期序列值。该行无法确定归属日期,不予导入。`,
    );
    return null;
  }
  if (!Number.isInteger(serial)) {
    log.add(
      cellRef(r, c),
      `${DATE_COLUMN} 的序列值 ${serial} 含时间部分。本系统按"日"归集工时,` +
        "请把该列格式改为纯日期后重新导出。",
    );
    return null;
  }
  if (serial < MIN_DATE_SERIAL || serial > MAX_DATE_SERIAL) {
    log.add(
      cellRef(r, c),
      `${DATE_COLUMN} 的序列值 ${serial} 超出合理范围` +
        `(${MIN_DATE_SERIAL}~${MAX_DATE_SERIAL}),不像一个考勤日期。`,
    );
    return null;
  }

  const day = new Date(EXCEL_EPOCH_UTC_MS + serial * MS_PER_DAY);
  try {
    return assertCalendarDay(day);
  } catch (error) {
    log.add(
      cellRef(r, c),
      `${DATE_COLUMN} 无法换算为日期：` +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

/**
 * Parses one day's attendance workbook into rows, reporting every fault at once.
 *
 * Enforces, in order: a parseable workbook; exactly one sheet; a non-empty range; a
 * row count within MAX_GRID_ROWS; all 18 D-125 mandatory columns present and
 * unambiguous; no merged range over a kept row; a usable date and finite hours in
 * every kept row; and no repeated (工号, 出勤日期) pair.
 *
 * Rows with a blank 工号 are dropped, not faulted - that is the totals row. A file whose
 * only row IS the totals row therefore parses to zero rows and still returns ok:true;
 * D-170 requires that shape to be a rest-day report, not a failed import.
 *
 * Never throws for a malformed workbook: a corrupt file is an expected input, so every
 * fault becomes a problem entry. Only a genuine bug throws.
 *
 * @param buffer raw bytes of the .xls file, already size-checked by the caller.
 */
export function parseAttendanceWorkbook(buffer: Buffer): ParseAttendanceResult {
  const log = new ProblemLog();

  let workbook: ReturnType<typeof readWorkbook>;
  try {
    // cellFormula/cellHTML off: neither is read below, and not building them keeps the
    // parser away from the parts of the format with the most surface area.
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
            "无法解析该文件,请确认它是未加密的考勤 .xls 工作簿。" +
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
            "多表工作簿无法确定该读哪一张,请删除多余工作表后重新导出。",
        },
      ],
    };
  }

  const sheetName = workbook.SheetNames[0] as string;
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined || sheet["!ref"] === undefined) {
    return {
      ok: false,
      problems: [
        { where: null, message: `工作表"${sheetName}"是空的,没有可导入的数据。` },
      ],
    };
  }

  const range = xlsxUtils.decode_range(sheet["!ref"]);
  const gridRows = range.e.r - range.s.r + 1;
  if (gridRows > MAX_GRID_ROWS) {
    return {
      ok: false,
      problems: [
        {
          where: null,
          message:
            `工作表有 ${gridRows} 行,超过上限 ${MAX_GRID_ROWS} 行。` +
            "这不像一天的考勤数据,请确认导出范围。",
        },
      ],
    };
  }

  // raw:true only. Unlike the plan sheet there is no display/stored divergence to
  // reconcile here, and the formatted text would round away the half hours that make
  // up most of the overtime columns.
  const grid = xlsxUtils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  const columns = mapHeader(grid, log);
  if (columns === null) {
    return { ok: false, problems: log.take() };
  }

  const mergedRows = mergedRowFlags(sheet["!merges"] ?? [], grid.length);

  /**
   * Column index by header name.
   *
   * Throws rather than logs: mapHeader() has already proved every required name is
   * present, so a miss here is a bug in this module's own column tables, not a defect
   * in the uploaded file, and it must not be reported to the administrator as one.
   */
  const at = (name: string): number => {
    const index = columns.get(name);
    if (index === undefined) {
      throw new Error(`Column "${name}" passed the header check but is unmapped`);
    }
    return index;
  };
  const noColumn = at(NO_COLUMN);
  const dateColumn = at(DATE_COLUMN);

  const rows: ParsedAttendanceRow[] = [];
  const seenKeys = new Set<string>();
  const dateKeys = new Map<number, Date>();
  let droppedRows = 0;

  for (let r = 1; r < grid.length; r += 1) {
    const employeeNo = textOf(grid, r, noColumn);
    if (employeeNo === "") {
      // The totals row - measured at grid index 576 with 请假时间 412 / 上班时数 4188.
      droppedRows += 1;
      continue;
    }

    if (mergedRows[r] === true) {
      log.add(
        `第 ${r + 1} 行`,
        "该行含合并单元格。合并会让被覆盖的单元格读出空值(即 0 工时)," +
          "无法确定数值归属,请取消合并后重新导出。",
      );
      continue;
    }

    const workDate = readDateCell(grid, r, dateColumn, log);
    if (workDate === null) {
      continue;
    }

    const dupKey = `${employeeNo}${workDate.getTime()}`;
    if (seenKeys.has(dupKey)) {
      log.add(
        `第 ${r + 1} 行`,
        `工号 ${employeeNo} 在同一天(${workDate.toISOString().slice(0, 10)})` +
          "出现多行。一人一天只应有一行,重复行会让后写入的一行静默覆盖前一行。",
      );
      continue;
    }
    seenKeys.add(dupKey);
    dateKeys.set(workDate.getTime(), workDate);

    const numbers = {} as Record<NumericField, number>;
    for (const [name, field] of Object.entries(NUMERIC_COLUMNS) as [
      string,
      NumericField,
    ][]) {
      numbers[field] = readHourCell(grid, r, at(name), name, log);
    }

    rows.push({
      excelRow: r + 1,
      employeeNo,
      employeeName: nullableText(textOf(grid, r, at("姓名"))),
      workDate,
      // 部别 is kept verbatim including "" and HR's literal "（空）" placeholder: it is
      // only ever used to resolve a Section, and an unresolvable value is a warning
      // (未归属工时), not a reason to reject the whole day's import.
      hrDeptName: textOf(grid, r, at("部别")),
      hrSectionName: nullableText(textOf(grid, r, at("课别"))),
      jobTitle: nullableText(textOf(grid, r, at("职务"))),
      employeeCategory: nullableText(textOf(grid, r, at("员工类别"))),
      ...numbers,
    });
  }

  if (log.length > 0) {
    return { ok: false, problems: log.take() };
  }

  // Zero data rows is a SUCCESS, not a failure (D-170). A rest-day report from HR is
  // structurally exactly this: header + totals row, no employee rows. This branch used
  // to return ok:false ("文件里没有任何有效数据行"), which made every weekend file look
  // like a broken import - and an alarm that fires on normal days trains the operator
  // to ignore it, which costs the whole three-state health signal.
  //
  // The distinction is safe because it comes AFTER the `log.length > 0` gate above: a
  // genuinely malformed file has already failed on its structural faults. Reaching here
  // with no rows means the file parsed cleanly and simply has nothing to say. The
  // caller sees rows: [] and decides what to log; see classifyAttendanceParse().
  const workDates = [...dateKeys.values()].sort((a, b) => a.getTime() - b.getTime());
  return { ok: true, parsed: { rows, workDates, droppedRows } };
}
