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

import { ACTUAL_SOURCE_MANUAL } from "@/lib/db/actual-source";
import { FISCAL_MONTH_COUNT, fiscalMonthLabel, monthToIndex } from "@/lib/db/date";
import type { ActualEffectiveRow, OrgSnapshot } from "@/lib/db/types";

/** One (section, month) figure triple. */
export interface ActualsCell {
  /** 1..12, where 1 = April. */
  month: number;
  /** e.g. "26/04". Derived from the fiscal year, not a fixed table. */
  label: string;
  personnelHours: number;
  /** May be negative - deductions can exceed additions (see ActualRow). */
  overtimeHours: number;
  /**
   * The FOLDED total only - what the attendance import produced (D-233).
   *
   * Kept as the fold rather than the effective figure so this field's meaning is
   * unchanged from before adjustment slips existed. Anything reading `totalHours`
   * and not yet aware of slips then shows a visibly low number instead of a
   * plausible blend nobody would question.
   */
  totalHours: number;
  /**
   * Sum of un-revoked slips for this (section, month), 0 when there are none (D-233).
   *
   * Signed: a slip may subtract. Note that 0 does not prove no slip exists - two live
   * slips can net to zero - which is why the page takes its "this month was adjusted"
   * caption from the slip-driven list the repository returns, not from this number.
   */
  adjustmentHours: number;
  /** totalHours + adjustmentHours. This is 实绩 as D-141 defines it. */
  effectiveHours: number;
  /**
   * True when the fold moved after a slip on this cell was written (D-233).
   *
   * MEANS "SUSPECT", NOT "WRONG": nothing is rescaled and no slip is dropped. The
   * case it exists for is 8月 - slips entered against a 26-31日-only base of 6870,
   * then the 1-25日 detail arrives, the fold rebuilds to ~31000, and the slips keep
   * being added on top. The double count is invisible in every figure on the page,
   * which is why it needs its own flag rather than a plausibility check on the total.
   */
  foldChangedSinceAdjustment: boolean;
  /**
   * False when neither a folded row nor an un-revoked slip exists for this
   * (section, month).
   *
   * The distinction matters more here than on the plan grid: a missing actual
   * means the attendance file for that month was never imported, while a stored
   * zero means it was imported and the section genuinely logged nothing. Both
   * render as "0", and only the first one is a data problem to chase.
   *
   * A slip alone is enough to make this true, and such a cell shows a 0 fold. That
   * reads correctly next to the adjustment figure beside it: the month was never
   * imported, and the hours came from a hand tally.
   */
  present: boolean;
  /**
   * True when the figure was typed in by hand rather than folded from attendance
   * detail (D-198).
   *
   * Carried per cell because it changes what the neighbouring numbers mean: a manual
   * row holds the whole month in `totalHours` with `personnelHours` and
   * `overtimeHours` at 0, so those two zeros are "unknown", not "none". Unmarked,
   * they read as a section that logged no overtime at all.
   */
  isManualBaseline: boolean;
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
  /** Folded hours across the year. See ActualsCell.totalHours for why it stays the fold. */
  total: number;
  /** Signed sum of un-revoked slips across the year, 0 when there are none (D-233). */
  adjustmentTotal: number;
  /**
   * The section's 实绩 for the year: the sum of its cells' `effectiveHours`.
   *
   * Summed from the cells rather than computed as `total + adjustmentTotal` so the row
   * total always equals what the row displays. The two agree whenever the merge's own
   * invariant holds; summing the cells means a violation shows up as a wrong total
   * instead of as a total that quietly disagrees with the numbers above it.
   */
  effectiveTotal: number;
  /**
   * Count of months with a folded row or an un-revoked slip - 0 means this section
   * has no actuals yet.
   */
  monthsWithData: number;
}

/** Column footer: one month summed across all sections. */
export interface ActualsMonthTotal {
  month: number;
  label: string;
  personnelHours: number;
  overtimeHours: number;
  /** Folded hours summed across sections. */
  totalHours: number;
  /** Signed sum of un-revoked slips across sections for this month (D-233). */
  adjustmentHours: number;
  /** totalHours + adjustmentHours - the column's 实绩. */
  effectiveHours: number;
  /** Sections that reported this month. Drives the "partial month" hint. */
  sectionsWithData: number;
  /**
   * True when at least one section's figure for this month is a manual baseline
   * (D-198).
   *
   * Any-not-all on purpose. The column footer sums personnel and overtime hours
   * across sections, and one manual row is enough to make that sum an undercount
   * of what actually happened - so the caveat has to appear as soon as a single
   * one is mixed in, not only when the whole column is manual.
   */
  hasManualBaseline: boolean;
}

/**
 * One section-month the fold-drift warning has to name (D-233).
 *
 * The banner names section-months rather than reporting a count because the operator's
 * next action is to open those slips and decide; "3 处存在偏差" leaves them hunting
 * across a 24x12 grid for cells that look no different from the rest.
 */
export interface ActualsDriftRef {
  sectionId: string;
  sectionName: string;
  /** 1..12, where 1 = April. */
  month: number;
  /** e.g. "26/08". */
  label: string;
}

/** The whole view plus the aggregates the page header reports. */
export interface ActualsView {
  rows: readonly ActualsRow[];
  /** Column headers, 12 entries, index 0 = April. */
  monthLabels: readonly string[];
  monthTotals: readonly ActualsMonthTotal[];
  /** Months (1..12) with at least one folded row or un-revoked slip, ascending. */
  monthsWithData: readonly number[];
  /**
   * Months (1..12) holding at least one manual baseline figure, ascending.
   *
   * Derived from the stored rows, never a hard-coded list of the months that
   * happened to be back-filled: the moment 8月 or 9月 is imported the same way, a
   * literal "4~7 月" footnote in the UI becomes a lie that nothing would catch.
   */
  manualBaselineMonths: readonly number[];
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
  /** Folded hours across the whole view. */
  total: number;
  /** Signed sum of every un-revoked slip in the view, 0 when there are none (D-233). */
  adjustmentTotal: number;
  /** Sum of every row's `effectiveTotal` - the figure the page reports as 实绩合计. */
  effectiveTotal: number;
  /**
   * Section-months whose fold moved after a slip was written, in row order (D-233).
   *
   * Empty is the normal state, and the page shows nothing at all when it is - a banner
   * that is always present is a banner nobody reads.
   */
  foldDriftCells: readonly ActualsDriftRef[];
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
 * @param actuals - MERGED rows for ONE fiscal year, i.e. the output of
 *   findEffectiveActualsByFiscalYear() (D-233). Merged rather than fold rows plus a
 *   second slip parameter because the merge has already collapsed the slips to one row
 *   per (section, month); handed the slips separately, this function would have to
 *   re-implement that grouping, and the two summations would be free to disagree.
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
 *   A slip against a deleted section arrives here the same way, and has to be as
 *   loud: an adjustment nobody can see is an unaccounted-for pile of hours.
 * @throws if a row carries a month outside 1..12, which would write past the end
 *   of the 12-cell array. upsertActual already rejects these on the way in; this
 *   is the read-side half of the same guard.
 */
export function buildActualsView(
  snapshot: OrgSnapshot,
  actuals: readonly ActualEffectiveRow[],
  fiscalYear: { id: string; year: number },
): ActualsView {
  const departmentNames = new Map(
    snapshot.departments.map((department) => [department.id, department.name]),
  );
  const knownSections = new Set(snapshot.sections.map((section) => section.id));

  const byCell = new Map<string, ActualEffectiveRow>();
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
    adjustmentHours: 0,
    effectiveHours: 0,
    sectionsWithData: 0,
    hasManualBaseline: false,
  }));

  const foldDriftCells: ActualsDriftRef[] = [];
  let sectionsWithData = 0;
  let personnelTotal = 0;
  let overtimeTotal = 0;
  let total = 0;
  let adjustmentTotal = 0;
  let effectiveTotal = 0;

  const rows = snapshot.sections.map((section) => {
    const cells: ActualsCell[] = [];
    let rowPersonnel = 0;
    let rowOvertime = 0;
    let rowTotal = 0;
    let rowAdjustment = 0;
    let rowEffective = 0;
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
      const adjustmentHours = stored?.adjustmentHours ?? 0;
      // Same rule one level up: the merge owns `effectiveHours` and asserts it is finite,
      // so take its number instead of re-adding the parts here.
      const effectiveHours = stored?.effectiveHours ?? 0;
      const foldChangedSinceAdjustment = stored?.foldChangedSinceAdjustment ?? false;
      // A cell with no stored row is not a manual baseline - it is nothing at all.
      // Guarding on `present` keeps the absent case out of the marker, so the tooltip
      // never claims a provenance for a figure that was never entered.
      const cellIsManualBaseline = present && stored.source === ACTUAL_SOURCE_MANUAL;

      if (present) {
        monthsWithData += 1;
        const footer = monthTotals[index];
        if (footer !== undefined) {
          footer.personnelHours += personnelHours;
          footer.overtimeHours += overtimeHours;
          footer.totalHours += totalHours;
          footer.adjustmentHours += adjustmentHours;
          footer.effectiveHours += effectiveHours;
          footer.sectionsWithData += 1;
          if (cellIsManualBaseline) {
            footer.hasManualBaseline = true;
          }
        }
      }

      if (foldChangedSinceAdjustment) {
        foldDriftCells.push({
          sectionId: section.id,
          sectionName: section.name,
          month,
          label: monthLabels[monthToIndex(month)] ?? `#${month}`,
        });
      }

      rowPersonnel += personnelHours;
      rowOvertime += overtimeHours;
      rowTotal += totalHours;
      rowAdjustment += adjustmentHours;
      rowEffective += effectiveHours;
      cells.push({
        month,
        label: monthLabels[monthToIndex(month)] ?? `#${month}`,
        personnelHours,
        overtimeHours,
        totalHours,
        adjustmentHours,
        effectiveHours,
        foldChangedSinceAdjustment,
        present,
        isManualBaseline: cellIsManualBaseline,
      });
    }

    if (monthsWithData > 0) {
      sectionsWithData += 1;
    }
    personnelTotal += rowPersonnel;
    overtimeTotal += rowOvertime;
    total += rowTotal;
    adjustmentTotal += rowAdjustment;
    effectiveTotal += rowEffective;

    return {
      sectionId: section.id,
      sectionName: section.name,
      departmentId: section.departmentId,
      departmentName: departmentNames.get(section.departmentId) ?? "（未知部门）",
      cells,
      personnelTotal: rowPersonnel,
      overtimeTotal: rowOvertime,
      total: rowTotal,
      adjustmentTotal: rowAdjustment,
      effectiveTotal: rowEffective,
      monthsWithData,
    };
  });

  const monthsWithData = monthTotals
    .filter((month) => month.sectionsWithData > 0)
    .map((month) => month.month);

  const manualBaselineMonths = monthTotals
    .filter((month) => month.hasManualBaseline)
    .map((month) => month.month);

  return {
    rows,
    monthLabels,
    monthTotals,
    monthsWithData,
    manualBaselineMonths,
    latestMonthWithData: monthsWithData.at(-1) ?? null,
    sectionsWithData,
    personnelTotal,
    overtimeTotal,
    total,
    adjustmentTotal,
    effectiveTotal,
    foldDriftCells,
  };
}
