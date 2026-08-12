// Assembles the actuals view: flat actual rows -> 24 sections x 12 months.
//
// Pure functions over DTOs, no database and no React - the same split as
// lib/plans/grid.ts, and for the same reason: the /actuals Server Component reads
// the repositories and hands the results here, so the shape logic stays
// unit-testable and the page stays fetch-and-render.
//
// Month semantics, restated because this is where the two conventions meet: the
// database stores `month` as 1..12 with 1 = April, and `cells` is indexed 0..11.
// monthToIndex() is the only conversion, exactly as in buildOrgRoot().
//
// Deliberately NOT here: plan-vs-actual achievement. The dashboard owns that
// comparison (it needs plan, challenge and actual on one axis); duplicating a
// second achievement formula on this page is how the two would drift apart.

import { FISCAL_MONTH_COUNT, fiscalMonthLabel, monthToIndex } from "@/lib/db/date";
import type { ActualRow, OrgSnapshot } from "@/lib/db/types";

/** One (section, month) figure triple. */
export interface ActualsCell {
  /** 1..12, where 1 = April. */
  month: number;
  /** e.g. "26/04". Derived from the fiscal year, not a fixed table. */
  label: string;
  personnelHours: number;
  /** May be negative - deductions can exceed additions (see ActualRow). */
  overtimeHours: number;
  totalHours: number;
  /**
   * False when no aggregate row exists for this (section, month).
   *
   * The distinction matters more here than on the plan grid: a missing actual
   * means the attendance file for that month was never imported, while a stored
   * zero means it was imported and the section genuinely logged nothing. Both
   * render as "0", and only the first one is a data problem to chase.
   */
  present: boolean;
}

/** One section's row: 12 cells plus its department for grouping. */
export interface ActualsRow {
  sectionId: string;
  sectionName: string;
  departmentId: string;
  departmentName: string;
  cells: readonly ActualsCell[];
  personnelTotal: number;
  overtimeTotal: number;
  total: number;
  /** Count of months with a stored row - 0 means this section has no actuals yet. */
  monthsWithData: number;
}

/** Column footer: one month summed across all sections. */
export interface ActualsMonthTotal {
  month: number;
  label: string;
  personnelHours: number;
  overtimeHours: number;
  totalHours: number;
  /** Sections that reported this month. Drives the "partial month" hint. */
  sectionsWithData: number;
}

/** The whole view plus the aggregates the page header reports. */
export interface ActualsView {
  rows: readonly ActualsRow[];
  /** Column headers, 12 entries, index 0 = April. */
  monthLabels: readonly string[];
  monthTotals: readonly ActualsMonthTotal[];
  /** Months (1..12) that have at least one stored row, ascending. */
  monthsWithData: readonly number[];
  /**
   * Highest month with data, or null when the year is empty.
   *
   * The page uses this as the default focus month for the unattributed-hours
   * banner. Deriving it from the data rather than from today's date is the point:
   * the calendar month and the last imported month are routinely different, and
   * defaulting to today would show an empty banner for a month nobody has
   * imported yet - which reads as "nothing unattributed" instead of "no data".
   */
  latestMonthWithData: number | null;
  /** Sections with at least one stored month. */
  sectionsWithData: number;
  personnelTotal: number;
  overtimeTotal: number;
  total: number;
}

/**
 * Key for the (sectionId, month) lookup.
 *
 * Deliberately excludes fiscalYearId: `buildActualsView` is called with the rows
 * of ONE fiscal year and asserts as much below, so including it would only pad
 * the key. Mirrors the same decision in buildPlanGrid and the org-tree adapter.
 */
function cellKey(sectionId: string, month: number): string {
  return `${sectionId}#${month}`;
}

/**
 * Folds flat actual rows into a section x month view.
 *
 * @param snapshot - the org, already ordered by (sortOrder, name). Row order
 *   follows it directly so the view matches /admin, /plans and the dashboard.
 * @param actuals - aggregate rows for ONE fiscal year.
 * @param fiscalYear - the year the labels and the single-year check derive from.
 *
 * @throws if `actuals` contains a row from a different fiscal year. The
 *   (sectionId, month) index below would otherwise let one year silently
 *   overwrite the other, and the operator would be reading FY2027 hours on a
 *   page labelled FY2026.
 * @throws if a row references a section absent from the snapshot. An orphan
 *   aggregate means the org table and the actuals table disagree - most likely a
 *   section was renamed or deleted after a rebuild - and dropping the row from a
 *   screen whose job is to account for every hour would hide the discrepancy.
 * @throws if a row carries a month outside 1..12, which would write past the end
 *   of the 12-cell array. upsertActual already rejects these on the way in; this
 *   is the read-side half of the same guard.
 */
export function buildActualsView(
  snapshot: OrgSnapshot,
  actuals: readonly ActualRow[],
  fiscalYear: { id: string; year: number },
): ActualsView {
  const departmentNames = new Map(
    snapshot.departments.map((department) => [department.id, department.name]),
  );
  const knownSections = new Set(snapshot.sections.map((section) => section.id));

  const byCell = new Map<string, ActualRow>();
  for (const row of actuals) {
    if (row.fiscalYearId !== fiscalYear.id) {
      throw new Error(
        `Actual row for section ${row.sectionId} belongs to fiscal year ` +
          `${row.fiscalYearId}, not ${fiscalYear.id}. Mixing years in one view ` +
          "would let one overwrite the other silently.",
      );
    }
    if (!knownSections.has(row.sectionId)) {
      throw new Error(
        `Actual row references unknown section ${row.sectionId}. The org snapshot ` +
          "and the actuals table have diverged - rebuild the month or fix the org data.",
      );
    }
    if (!Number.isInteger(row.month) || row.month < 1 || row.month > FISCAL_MONTH_COUNT) {
      throw new Error(
        `Actual row for section ${row.sectionId} carries month ${row.month}, ` +
          `outside 1..${FISCAL_MONTH_COUNT}. It cannot be placed in a 12-month row.`,
      );
    }
    byCell.set(cellKey(row.sectionId, row.month), row);
  }

  const monthLabels = Array.from({ length: FISCAL_MONTH_COUNT }, (_unused, index) =>
    fiscalMonthLabel(fiscalYear.year, index + 1),
  );

  const monthTotals: ActualsMonthTotal[] = monthLabels.map((label, index) => ({
    month: index + 1,
    label,
    personnelHours: 0,
    overtimeHours: 0,
    totalHours: 0,
    sectionsWithData: 0,
  }));

  let sectionsWithData = 0;
  let personnelTotal = 0;
  let overtimeTotal = 0;
  let total = 0;

  const rows = snapshot.sections.map((section) => {
    const cells: ActualsCell[] = [];
    let rowPersonnel = 0;
    let rowOvertime = 0;
    let rowTotal = 0;
    let monthsWithData = 0;

    for (let index = 0; index < FISCAL_MONTH_COUNT; index += 1) {
      const month = index + 1;
      const stored = byCell.get(cellKey(section.id, month));
      const present = stored !== undefined;
      const personnelHours = stored?.personnelHours ?? 0;
      const overtimeHours = stored?.overtimeHours ?? 0;
      // Read the stored total rather than re-adding the two parts: calc.ts owns
      // the D-110 formula, and recomputing it here would silently diverge the day
      // that formula changes.
      const totalHours = stored?.totalHours ?? 0;

      if (present) {
        monthsWithData += 1;
        const footer = monthTotals[index];
        if (footer !== undefined) {
          footer.personnelHours += personnelHours;
          footer.overtimeHours += overtimeHours;
          footer.totalHours += totalHours;
          footer.sectionsWithData += 1;
        }
      }

      rowPersonnel += personnelHours;
      rowOvertime += overtimeHours;
      rowTotal += totalHours;
      cells.push({
        month,
        label: monthLabels[monthToIndex(month)] ?? `#${month}`,
        personnelHours,
        overtimeHours,
        totalHours,
        present,
      });
    }

    if (monthsWithData > 0) {
      sectionsWithData += 1;
    }
    personnelTotal += rowPersonnel;
    overtimeTotal += rowOvertime;
    total += rowTotal;

    return {
      sectionId: section.id,
      sectionName: section.name,
      departmentId: section.departmentId,
      departmentName: departmentNames.get(section.departmentId) ?? "（未知部门）",
      cells,
      personnelTotal: rowPersonnel,
      overtimeTotal: rowOvertime,
      total: rowTotal,
      monthsWithData,
    };
  });

  const monthsWithData = monthTotals
    .filter((month) => month.sectionsWithData > 0)
    .map((month) => month.month);

  return {
    rows,
    monthLabels,
    monthTotals,
    monthsWithData,
    latestMonthWithData: monthsWithData.at(-1) ?? null,
    sectionsWithData,
    personnelTotal,
    overtimeTotal,
    total,
  };
}
