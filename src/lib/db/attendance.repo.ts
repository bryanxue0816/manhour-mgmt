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
import { ACTUAL_SOURCE_MANUAL } from "./actual-source";
import {
  assertCalendarDay,
  fiscalMonthLabel,
  fiscalMonthOf,
  fiscalMonthRange,
  fiscalYearOf,
  formatDateOnly,
} from "./date";
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
  /**
   * D-229: rows marked superseded because HR deleted them since the earlier fetch.
   *
   * 0 also when the sharp-drop guard refused to supersede, so it does not prove
   * "nothing was removed" - read it together with `supersedeSkipped`.
   */
  supersededCount: number;
  /**
   * One message per workDate where the sharp-drop guard refused to supersede, empty
   * when it never fired. Surfaced by the caller so a suppressed deletion cannot pass
   * as a clean import.
   */
  supersedeSkipped: readonly string[];
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
    // D-229: reappearing means live again. A row HR deleted in the morning and restored
    // in the afternoon must rejoin the totals, so every write clears the supersede mark
    // rather than leaving it for the supersede pass to reason about.
    supersededAt: null,
    supersededBy: null,
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
 * D-229 sharp-drop guard: the smallest share of a day's currently live rows an incoming
 * file may carry and still be trusted to supersede.
 *
 * 0.8, i.e. a drop of more than 20% suppresses supersede. DELIBERATELY not a settled
 * value - same status as D-222's 10% threshold, to be calibrated once several days of
 * real two-fetch data exist. The failure mode is measured, not hypothetical: the two real
 * samples both carried 出勤日期 2026-08-25 yet held 580 and 183 rows. Without this guard a
 * narrowed export would silently erase ~400 people's day, and the monthly total, which is
 * a full recompute, would faithfully follow it down.
 */
const SUPERSEDE_MIN_RETAINED_RATIO = 0.8;

/** One distinct 出勤日期 in the incoming file, with how many rows it carries. */
interface IncomingDay {
  readonly workDate: Date;
  readonly incoming: number;
}

/**
 * Rows per distinct 出勤日期, keyed by epoch ms.
 *
 * Keyed by number, not Date: Map compares Date by reference, so two equal calendar days
 * would become two entries and each would supersede the other's rows.
 */
function incomingRowsByDate(
  rows: readonly ParsedAttendanceRow[],
): Map<number, IncomingDay> {
  const byDate = new Map<number, IncomingDay>();
  for (const row of rows) {
    const key = row.workDate.getTime();
    const seen = byDate.get(key);
    byDate.set(key, { workDate: row.workDate, incoming: (seen?.incoming ?? 0) + 1 });
  }
  return byDate;
}

/** The wording an operator sees when the sharp-drop guard suppressed a supersede. */
function supersedeSkipMessage(workDate: Date, incoming: number, before: number): string {
  return (
    `${formatDateOnly(workDate)}：该文件仅含 ${String(incoming)} 行，` +
    `库内该日现有 ${String(before)} 行，减少超过 ` +
    `${String(Math.round((1 - SUPERSEDE_MIN_RETAINED_RATIO) * 100))}%，` +
    "已跳过撤销、仅更新数据，请人工确认 HR 导出范围是否被缩小。"
  );
}

/**
 * Stores parsed rows and rebuilds every fiscal month they touch.
 *
 * @param rows parsed attendance rows; an empty array is a no-op returning zeros.
 * @param sourceFile file name recorded on every row and every rebuilt Actual.
 * @param fetchedAt when the file was obtained, recorded on Actual for staleness display.
 * @param options.supersedeMissing D-229: mark rows absent from this file as superseded,
 *   for the same 出勤日期 only. Defaults to FALSE deliberately - supersede is destructive to
 *   totals, so it must be opted into by the one caller that knows the parse was clean.
 *   PARTIAL must never pass true: a half-parsed file is not an authoritative snapshot.
 * @returns rows stored, one rebuild summary per affected month, and the supersede outcome.
 * @throws if a row's fiscal year has no FiscalYear record - Actual.fiscalYearId is a
 *   required relation, so the month cannot be aggregated at all and importing the detail
 *   while silently skipping the aggregate would show the section at zero.
 */
export async function importAttendanceRows(
  rows: readonly ParsedAttendanceRow[],
  sourceFile: string,
  fetchedAt: Date = new Date(),
  options: { readonly supersedeMissing?: boolean } = {},
): Promise<AttendanceImportResult> {
  // Also carries D-229 boundary 6: a rest-day file holding only the totals row parses to
  // zero rows (D-209 still judges it SUCCESS), and returning here is what stops it from
  // superseding that entire day. Do not move this check below the supersede pass.
  if (rows.length === 0) {
    return { rowsStored: 0, months: [], supersededCount: 0, supersedeSkipped: [] };
  }

  const supersedeMissing = options.supersedeMissing === true;
  const context = await loadAttendanceCalcContext();
  const computed = computeAttendanceRows(rows, context);
  const months = affectedMonthsOf(rows);
  const byDate = incomingRowsByDate(rows);

  // Resolved before the write: a missing FiscalYear must fail with nothing stored,
  // rather than leave detail rows whose month can never be aggregated.
  const fiscalYearIdByYear = await resolveFiscalYearIds(months);

  // D-198: refused before the write for the same reason. A month carrying a hand-typed
  // baseline has no attendance detail behind it, so re-folding it writes zeros. This must
  // stay ahead of the supersede pass too - refusing after rows were superseded would
  // leave the day reduced with no aggregate rebuild to reveal it.
  const blocked = await findManualBaselineMonths(months, fiscalYearIdByYear);
  if (blocked.length > 0) {
    throw new Error(manualBaselineRejection(blocked));
  }

  const written = await prisma.$transaction(async (tx) => {
    // Read BEFORE the upserts below. Afterwards the rows this very file writes would be
    // counted as pre-existing, inflating the baseline and blunting the guard.
    const liveBefore = new Map<number, number>();
    if (supersedeMissing) {
      for (const [key, day] of byDate) {
        liveBefore.set(
          key,
          await tx.attendanceRaw.count({
            where: { workDate: day.workDate, supersededAt: null },
          }),
        );
      }
    }

    for (const [index, row] of rows.entries()) {
      const figures = computed[index];
      if (figures === undefined) {
        // Unreachable - computeAttendanceRows is index-parallel by construction. Kept
        // because a skipped row here would under-report a section with no error.
        throw new Error(`importAttendanceRows: missing computed row at index ${index}`);
      }
      await tx.attendanceRaw.upsert(attendanceUpsertArgs(row, figures, sourceFile));
    }

    if (!supersedeMissing) {
      return { rowsStored: rows.length, supersededCount: 0, skipped: [] as string[] };
    }

    let supersededCount = 0;
    const skipped: string[] = [];
    for (const [key, day] of byDate) {
      const before = liveBefore.get(key) ?? 0;
      // before === 0 is the first-ever import of that day: the comparison is false, the
      // supersede below matches nothing, and no special case is needed.
      if (before > 0 && day.incoming < before * SUPERSEDE_MIN_RETAINED_RATIO) {
        skipped.push(supersedeSkipMessage(day.workDate, day.incoming, before));
        continue;
      }
      // Identified by sourceFile rather than by listing the file's 工号: the upserts above
      // stamped every row this file carries with the current name, so whatever still holds
      // an older name is exactly what HR dropped. An `employeeNo: { notIn: [...] }` would
      // need one bind parameter per row - 580 today, over SQLite's limit at 1000 staff.
      const { count } = await tx.attendanceRaw.updateMany({
        where: {
          workDate: day.workDate,
          supersededAt: null,
          sourceFile: { not: sourceFile },
        },
        data: { supersededAt: fetchedAt, supersededBy: sourceFile },
      });
      supersededCount += count;
    }
    return { rowsStored: rows.length, supersededCount, skipped };
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

  return {
    rowsStored: written.rowsStored,
    months: rebuilt,
    supersededCount: written.supersededCount,
    supersedeSkipped: written.skipped,
  };
}

/**
 * The single wording of the manual-baseline refusal (D-198).
 *
 * Shared by the early check in importAttendanceRows() and by the last-resort guard inside
 * rebuildMonthlyActuals(): two hand-written variants would drift, and the operator reading
 * one of them has to be told the same recovery step either way.
 */
function manualBaselineRejection(labels: readonly string[]): string {
  return (
    `以下月份已录入手工基线实绩，考勤折算不会覆盖它们：${labels.join("、")}。` +
    "手工基线是上线前按月人工录入的合计工时，考勤明细里没有对应的日数据；" +
    "若在这些月份上重算，折算结果会是 0，等于把基线清零。" +
    "如确实要改用考勤折算，请先删除该月的手工基线实绩，再重新导入。"
  );
}

/**
 * Labels of those `months` that already hold a hand-typed baseline row (D-198).
 *
 * Runs BEFORE attendance_raw is written so a collision leaves the database untouched.
 * Throwing later - after the day rows have committed but before the month is re-folded -
 * would leave Actual disagreeing with AttendanceRaw with nothing on screen to reveal it.
 */
async function findManualBaselineMonths(
  months: readonly AffectedMonth[],
  fiscalYearIdByYear: ReadonlyMap<number, string>,
): Promise<string[]> {
  const blocked: string[] = [];
  for (const month of months) {
    const fiscalYearId = fiscalYearIdByYear.get(month.fiscalYear);
    // Undefined is impossible here - resolveFiscalYearIds() has already thrown on a gap.
    if (fiscalYearId === undefined) {
      continue;
    }
    const manualRows = await prisma.actual.count({
      where: { fiscalYearId, month: month.month, source: ACTUAL_SOURCE_MANUAL },
    });
    if (manualRows > 0) {
      blocked.push(fiscalMonthLabel(month.fiscalYear, month.month));
    }
  }
  return blocked;
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
 *
 * @throws if the month holds any `source: "manual"` row (D-198). Nothing is written and
 *   nothing is deleted - refusing is the whole point, because a hand-typed baseline has no
 *   attendance detail behind it and folding an empty month yields zeros.
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
    // D-198 last-resort guard, and the only one that is race-free. The check in
    // importAttendanceRows() runs outside this transaction, so a baseline import could
    // commit between it and this write; the deleteMany() below is scoped only by
    // (fiscalYearId, month) and would take the baseline with it. recomputeMonth() - the
    // rules-change entry point - reaches this function with no earlier check at all.
    const manualRows = await tx.actual.count({
      where: { fiscalYearId, month: month.month, source: ACTUAL_SOURCE_MANUAL },
    });
    if (manualRows > 0) {
      throw new Error(
        manualBaselineRejection([fiscalMonthLabel(month.fiscalYear, month.month)]),
      );
    }

    const stored = await tx.attendanceRaw.findMany({
      // D-229: superseded rows stay in the table but must not reach any total. This is a
      // full-month recompute, not an accumulate, so a deletion propagating to Actual is
      // free - the row simply stops being read and the month falls by that much.
      where: { workDate: { gte: from, lte: to }, supersededAt: null },
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
  // D-229: excludes superseded rows, so the gate counts what actually feeds the total.
  return prisma.attendanceRaw.count({
    where: { workDate: { gte: from, lte: to }, supersededAt: null },
  });
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
    // D-229: a superseded row must not keep the /actuals warning banner lit.
    where: { workDate: { gte: from, lte: to }, supersededAt: null },
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
