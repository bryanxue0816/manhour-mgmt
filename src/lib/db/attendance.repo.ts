// Attendance repository: stores the day rows, then rebuilds the months they touch.
//
// This is the impure half of the T4C pipeline. lib/attendance/calc.ts owns the
// arithmetic and the exclusion verdicts; this module owns the two writes and the read
// between them.
//
// D-126 - a day landing triggers an IMMEDIATE recompute of its whole fiscal month, and
// the dashboard only ever reads `Actual`. The recompute re-reads every stored row of the
// month rather than adding the uploaded day onto whatever Actual already held: D-122
// allows a corrected day to overwrite an earlier one in place, and an incremental add
// would double-count it with no error anywhere.
//
// Both writes and the read sit in ONE transaction per month. A crash between "the day is
// stored" and "the month is recomputed" would otherwise leave Actual disagreeing with
// AttendanceRaw indefinitely, and nothing in the schema would reveal which of the two is
// stale.
//
// The recompute reads the RAW COLUMNS back, not the stored `personnelHours` /
// `overtimeHours` / exclusion flags, and re-runs calc.ts over them. That is what makes
// D-161 survivable: the exclusion lists grew after the first import, and re-folding
// stored post-exclusion figures would have required re-fetching the month from HR. The
// stored derived columns exist for querying one employee's contribution, never as the
// input to an aggregate.

import type { ParsedAttendanceRow } from "@/lib/attendance/parser";
import {
  aggregateAttendance,
  buildRuleIndex,
  buildSectionIndex,
  computeAttendanceRows,
  type AttendanceCalcContext,
  type AttendanceFacts,
  type ComputedAttendanceRow,
  type UnattributedGroup,
} from "@/lib/attendance/calc";
import { prisma } from "@/lib/prisma";
import { assertCalendarDay, fiscalMonthOf, fiscalMonthRange, fiscalYearOf } from "./date";
import { findAllJobTitleRules } from "./job-title-rule.repo";
import { loadOrgSnapshot } from "./org.repo";
import { loadSectionAliasMap } from "./section-alias.repo";

/** The ten raw columns plus the four identity columns, as read back from the table. */
const RAW_FACTS_SELECT = {
  workDate: true,
  hrDeptName: true,
  hrSectionName: true,
  jobTitle: true,
  leaveHours: true,
  workHours: true,
  normalOvertime: true,
  restDayDouble: true,
  holidayOvertime: true,
  restDayCompensate: true,
  compensatoryLeave: true,
  maternityLeave: true,
  nursingLeave: true,
  miscarriageLeave: true,
} as const;

/** One (fiscal year, month) pair a stored day belongs to. */
export interface AffectedMonth {
  /** The calendar year the fiscal year STARTS in. */
  fiscalYear: number;
  /** 1..12, 1 = April. */
  month: number;
}

/** What one month's rebuild produced. */
export interface MonthRebuildResult extends AffectedMonth {
  /** Rows read from attendance_raw for the month. */
  sourceRows: number;
  /** `Actual` rows written - one per section with any attributed hours. */
  actualRows: number;
  /** Hours that resolved to no section, POST-exclusion. */
  unattributedHours: number;
  /** Row count behind `unattributedHours`. */
  unattributedRows: number;
  /** Grouped by the HR (部, 課) spelling that failed to resolve. */
  unattributed: readonly UnattributedGroup[];
}

/** Outcome of storing one file and rebuilding everything it touched. */
export interface AttendanceImportResult {
  /** attendance_raw rows upserted - equals the parsed row count. */
  rowsStored: number;
  /** One entry per (fiscal year, month) the file touched, ascending. */
  months: readonly MonthRebuildResult[];
}

/**
 * Loads the org master, aliases and job-title rules needed to compute a row.
 *
 * One read of each per import, not per row: the maps make resolution and exclusion pure
 * functions, and all three tables are small enough that the round trips would dominate.
 */
export async function loadAttendanceCalcContext(): Promise<AttendanceCalcContext> {
  const [snapshot, aliasIndex, rules] = await Promise.all([
    loadOrgSnapshot(),
    loadSectionAliasMap(),
    findAllJobTitleRules(),
  ]);
  return {
    sectionIndex: buildSectionIndex(snapshot),
    aliasIndex,
    ruleIndex: buildRuleIndex(rules),
  };
}

/** Distinct (fiscal year, month) pairs the rows fall into, ascending. */
export function affectedMonthsOf(
  rows: readonly Pick<ParsedAttendanceRow, "workDate">[],
): AffectedMonth[] {
  const seen = new Map<string, AffectedMonth>();
  for (const row of rows) {
    assertCalendarDay(row.workDate);
    const fiscalYear = fiscalYearOf(row.workDate);
    const month = fiscalMonthOf(row.workDate);
    seen.set(`${String(fiscalYear)}|${String(month)}`, { fiscalYear, month });
  }
  return [...seen.values()].sort(
    (a, b) => a.fiscalYear - b.fiscalYear || a.month - b.month,
  );
}

/** Upsert payload for one parsed row plus its computed figures. */
function attendanceUpsertArgs(
  row: ParsedAttendanceRow,
  computed: ComputedAttendanceRow,
  sourceFile: string,
) {
  const mutable = {
    employeeName: row.employeeName,
    hrDeptName: row.hrDeptName,
    hrSectionName: row.hrSectionName,
    jobTitle: row.jobTitle,
    employeeCategory: row.employeeCategory,
    sectionId: computed.sectionId,
    leaveHours: row.leaveHours,
    workHours: row.workHours,
    normalOvertime: row.normalOvertime,
    restDayDouble: row.restDayDouble,
    holidayOvertime: row.holidayOvertime,
    restDayCompensate: row.restDayCompensate,
    compensatoryLeave: row.compensatoryLeave,
    maternityLeave: row.maternityLeave,
    nursingLeave: row.nursingLeave,
    miscarriageLeave: row.miscarriageLeave,
    personnelHours: computed.personnelHours,
    overtimeHours: computed.overtimeHours,
    totalHours: computed.totalHours,
    excludedPersonnel: computed.excludedPersonnel,
    excludedOvertime: computed.excludedOvertime,
    sourceFile,
  };
  const key = { employeeNo: row.employeeNo, workDate: row.workDate };
  return {
    where: { employeeNo_workDate: key },
    create: { ...key, ...mutable },
    update: mutable,
    select: { id: true },
  };
}

/**
 * Stores parsed rows and rebuilds every fiscal month they touch.
 *
 * @param rows parsed attendance rows; an empty array is a no-op returning zeros.
 * @param sourceFile file name recorded on every row and every rebuilt Actual.
 * @param fetchedAt when the file was obtained, recorded on Actual for staleness display.
 * @returns rows stored plus one rebuild summary per affected month.
 * @throws if a row's fiscal year has no FiscalYear record - Actual.fiscalYearId is a
 *   required relation, so the month cannot be aggregated at all and importing the detail
 *   while silently skipping the aggregate would show the section at zero.
 */
export async function importAttendanceRows(
  rows: readonly ParsedAttendanceRow[],
  sourceFile: string,
  fetchedAt: Date = new Date(),
): Promise<AttendanceImportResult> {
  if (rows.length === 0) {
    return { rowsStored: 0, months: [] };
  }

  const context = await loadAttendanceCalcContext();
  const computed = computeAttendanceRows(rows, context);
  const months = affectedMonthsOf(rows);

  // Resolved before the write: a missing FiscalYear must fail with nothing stored,
  // rather than leave detail rows whose month can never be aggregated.
  const fiscalYearIdByYear = await resolveFiscalYearIds(months);

  const rowsStored = await prisma.$transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      const figures = computed[index];
      if (figures === undefined) {
        // Unreachable - computeAttendanceRows is index-parallel by construction. Kept
        // because a skipped row here would under-report a section with no error.
        throw new Error(`importAttendanceRows: missing computed row at index ${index}`);
      }
      await tx.attendanceRaw.upsert(attendanceUpsertArgs(row, figures, sourceFile));
    }
    return rows.length;
  });

  const rebuilt: MonthRebuildResult[] = [];
  for (const month of months) {
    const fiscalYearId = fiscalYearIdByYear.get(month.fiscalYear);
    if (fiscalYearId === undefined) {
      throw new Error(
        `importAttendanceRows: no FiscalYear id for ${String(month.fiscalYear)}`,
      );
    }
    rebuilt.push(
      await rebuildMonthlyActuals(month, fiscalYearId, context, sourceFile, fetchedAt),
    );
  }

  return { rowsStored, months: rebuilt };
}

/** Maps each affected fiscal year onto its FiscalYear id, failing loudly on a gap. */
async function resolveFiscalYearIds(
  months: readonly AffectedMonth[],
): Promise<Map<number, string>> {
  const years = [...new Set(months.map((m) => m.fiscalYear))];
  const rows = await prisma.fiscalYear.findMany({
    where: { year: { in: years } },
    select: { id: true, year: true },
  });
  const byYear = new Map(rows.map((r) => [r.year, r.id]));
  const missing = years.filter((year) => !byYear.has(year));
  if (missing.length > 0) {
    throw new Error(
      `未找到财年记录：${missing.map(String).join(", ")}。` +
        "请先在管理页创建对应财年后重新导入。",
    );
  }
  return byYear;
}

/**
 * Re-folds one fiscal month from attendance_raw and replaces its `Actual` rows.
 *
 * Read and write share one transaction so a concurrent import of the same month cannot
 * interleave a read of the old rows with a write of the new totals.
 *
 * Sections that lost all their hours are DELETED rather than left at their old value:
 * an upsert-only rebuild would keep a stale figure alive after a correction removed the
 * last row of a section, and that is invisible in the dashboard - the bar simply stays.
 * The delete is scoped to (fiscalYearId, month) and to sections absent from the fold, so
 * it can never touch another month or the `Plan` table.
 */
export async function rebuildMonthlyActuals(
  month: AffectedMonth,
  fiscalYearId: string,
  context: AttendanceCalcContext,
  sourceFile: string | null = null,
  fetchedAt: Date | null = null,
): Promise<MonthRebuildResult> {
  const { from, to } = fiscalMonthRange(month.fiscalYear, month.month);

  return prisma.$transaction(async (tx) => {
    const stored = await tx.attendanceRaw.findMany({
      where: { workDate: { gte: from, lte: to } },
      select: RAW_FACTS_SELECT,
      orderBy: [{ workDate: "asc" }, { employeeNo: "asc" }],
    });

    // Asserted on READ as work-calendar.repo.ts does: a DateTime column can hold an
    // instant with a time component, and one such row shifts a fiscal boundary.
    const facts: AttendanceFacts[] = stored.map((row) => ({
      ...row,
      workDate: assertCalendarDay(row.workDate),
    }));

    const computed = computeAttendanceRows(facts, context);
    const { aggregates, unattributed, unattributedRows, unattributedHours } =
      aggregateAttendance(computed, facts);

    for (const bucket of aggregates) {
      const mutable = {
        personnelHours: bucket.personnelHours,
        overtimeHours: bucket.overtimeHours,
        totalHours: bucket.totalHours,
        sourceFile,
        fetchedAt,
      };
      const key = { sectionId: bucket.sectionId, fiscalYearId, month: month.month };
      await tx.actual.upsert({
        where: { sectionId_fiscalYearId_month: key },
        create: { ...key, ...mutable },
        update: mutable,
        select: { id: true },
      });
    }

    await tx.actual.deleteMany({
      where: {
        fiscalYearId,
        month: month.month,
        sectionId: { notIn: aggregates.map((a) => a.sectionId) },
      },
    });

    return {
      ...month,
      sourceRows: stored.length,
      actualRows: aggregates.length,
      unattributedHours,
      unattributedRows,
      unattributed,
    };
  });
}

/**
 * Rebuilds a month from stored rows alone, loading its own context.
 *
 * The entry point for a rules change: after an administrator edits JobTitleRule or adds a
 * SectionAlias, every affected month has to be re-folded, and there is no file involved.
 * `sourceFile` / `fetchedAt` are cleared to null because the resulting figures no longer
 * came from any single upload.
 */
export async function recomputeMonth(month: AffectedMonth): Promise<MonthRebuildResult> {
  const [context, fiscalYearIdByYear] = await Promise.all([
    loadAttendanceCalcContext(),
    resolveFiscalYearIds([month]),
  ]);
  const fiscalYearId = fiscalYearIdByYear.get(month.fiscalYear);
  if (fiscalYearId === undefined) {
    throw new Error(`recomputeMonth: no FiscalYear id for ${String(month.fiscalYear)}`);
  }
  return rebuildMonthlyActuals(month, fiscalYearId, context);
}

/** attendance_raw row count for a fiscal month - the gate-4 / gate-6 check. */
export async function countAttendanceRowsInMonth(month: AffectedMonth): Promise<number> {
  const { from, to } = fiscalMonthRange(month.fiscalYear, month.month);
  return prisma.attendanceRaw.count({ where: { workDate: { gte: from, lte: to } } });
}

/**
 * Unattributed hours for a fiscal month, for the /actuals warning banner.
 *
 * Recomputed from stored rows rather than cached on import: the banner has to stay
 * correct after a rules change that attributes some of those rows, and there is no
 * aggregate table for the unattributed bucket by design - it must never look like a
 * section.
 */
export async function findUnattributedHours(
  month: AffectedMonth,
): Promise<{ rows: number; hours: number; groups: readonly UnattributedGroup[] }> {
  const { from, to } = fiscalMonthRange(month.fiscalYear, month.month);
  const context = await loadAttendanceCalcContext();
  const stored = await prisma.attendanceRaw.findMany({
    where: { workDate: { gte: from, lte: to } },
    select: RAW_FACTS_SELECT,
    orderBy: [{ workDate: "asc" }, { employeeNo: "asc" }],
  });
  const facts: AttendanceFacts[] = stored.map((row) => ({
    ...row,
    workDate: assertCalendarDay(row.workDate),
  }));
  const result = aggregateAttendance(computeAttendanceRows(facts, context), facts);
  return {
    rows: result.unattributedRows,
    hours: result.unattributedHours,
    groups: result.unattributed,
  };
}
