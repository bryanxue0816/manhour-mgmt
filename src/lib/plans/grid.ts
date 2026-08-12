// Assembles the plan-entry grid: flat plan rows -> 24 sections x 12 months.
//
// Pure functions over DTOs, no database and no React. The /plans Server Component
// reads the repositories and hands the results here, which keeps the shape logic
// unit-testable and keeps the page itself down to fetch-and-render.
//
// Month semantics, restated because this is where the two conventions meet: the
// database stores `month` as 1..12 with 1 = April, and `cells` is indexed 0..11.
// monthToIndex() is the only conversion, exactly as in buildOrgRoot().

import { FISCAL_MONTH_COUNT, fiscalMonthLabel, monthToIndex } from "@/lib/db/date";
import type { OrgSnapshot, PlanRow } from "@/lib/db/types";

/** One editable cell: both quantities for one (section, month). */
export interface PlanGridCell {
  /** 1..12, where 1 = April. */
  month: number;
  /** e.g. "26/04". Derived from the fiscal year, not a fixed table. */
  label: string;
  plannedHours: number;
  challengeHours: number;
  /**
   * False when no plan row exists for this (section, month).
   *
   * Distinguished from a genuine zero, and the distinction is the reason this flag
   * exists: an unentered cell and a cell deliberately set to 0 both render as "0"
   * but mean opposite things - one is missing data the year cannot be closed
   * without, the other is a valid target. The grid greys the former.
   */
  present: boolean;
}

/** One section's row in the grid: 12 cells plus its department for grouping. */
export interface PlanGridRow {
  sectionId: string;
  sectionName: string;
  departmentId: string;
  departmentName: string;
  cells: readonly PlanGridCell[];
  /** Sum of the 12 planned values. Row-level total shown at the end of the row. */
  plannedTotal: number;
  challengeTotal: number;
  /** Count of months with no stored row - drives the completeness banner. */
  missingMonths: number;
  /**
   * Months where challenge > planned. Legal under D-151 and saved as entered; the
   * grid marks them so an operator can tell a deliberate inversion from a typo.
   */
  invertedMonths: number;
}

/** The whole grid plus the aggregates the page header reports. */
export interface PlanGrid {
  rows: readonly PlanGridRow[];
  /** Column headers, 12 entries, index 0 = April. */
  monthLabels: readonly string[];
  /** Sections with at least one missing month. */
  incompleteSections: number;
  /** Total cells where challenge > planned (D-151 warning, never a block). */
  invertedCells: number;
  plannedTotal: number;
  challengeTotal: number;
}

/**
 * Key for the (sectionId, month) lookup.
 *
 * Deliberately excludes fiscalYearId: `buildPlanGrid` is called with the rows of
 * ONE fiscal year and asserts as much below, so including it would only pad the
 * key. Mirrors the same decision in the org-tree adapter.
 */
function cellKey(sectionId: string, month: number): string {
  return `${sectionId}#${month}`;
}

/**
 * Folds flat plan rows into a section x month grid.
 *
 * @param snapshot - the org, already ordered by (sortOrder, name). Row order
 *   follows it directly so the grid matches /admin and the dashboard.
 * @param plans - plan rows for ONE fiscal year.
 * @param fiscalYear - the year the labels and the single-year check derive from.
 *
 * @throws if `plans` contains a row from a different fiscal year. PlanRow carries
 *   `fiscalYearId` precisely so this can be checked: the (sectionId, month) index
 *   below would otherwise let one year silently overwrite the other, and the
 *   operator would be editing FY2027 numbers on a page labelled FY2026.
 * @throws if a row references a section absent from the snapshot - an orphan plan
 *   row means the org table and the plan table disagree, which must not be papered
 *   over by dropping the row from a screen whose job is to show all of them.
 */
export function buildPlanGrid(
  snapshot: OrgSnapshot,
  plans: readonly PlanRow[],
  fiscalYear: { id: string; year: number },
): PlanGrid {
  const departmentNames = new Map(
    snapshot.departments.map((department) => [department.id, department.name]),
  );
  const knownSections = new Set(snapshot.sections.map((section) => section.id));

  const byCell = new Map<string, PlanRow>();
  for (const row of plans) {
    if (row.fiscalYearId !== fiscalYear.id) {
      throw new Error(
        `Plan row for section ${row.sectionId} belongs to fiscal year ` +
          `${row.fiscalYearId}, not ${fiscalYear.id}. Mixing years in one grid ` +
          "would let one overwrite the other silently.",
      );
    }
    if (!knownSections.has(row.sectionId)) {
      throw new Error(
        `Plan row references unknown section ${row.sectionId}. The org snapshot ` +
          "and the plan table have diverged - reseed or fix the org data.",
      );
    }
    byCell.set(cellKey(row.sectionId, row.month), row);
  }

  const monthLabels = Array.from({ length: FISCAL_MONTH_COUNT }, (_unused, index) =>
    fiscalMonthLabel(fiscalYear.year, index + 1),
  );

  let invertedCells = 0;
  let incompleteSections = 0;
  let plannedTotal = 0;
  let challengeTotal = 0;

  const rows = snapshot.sections.map((section) => {
    const cells: PlanGridCell[] = [];
    let rowPlanned = 0;
    let rowChallenge = 0;
    let missingMonths = 0;
    let invertedMonths = 0;

    for (let index = 0; index < FISCAL_MONTH_COUNT; index += 1) {
      const month = index + 1;
      const stored = byCell.get(cellKey(section.id, month));
      const planned = stored?.plannedHours ?? 0;
      const challenge = stored?.challengeHours ?? 0;
      const present = stored !== undefined;

      if (!present) {
        missingMonths += 1;
      }
      // Strict `>`: D-151 blesses equality (5 sections set both values the same),
      // so flagging it would put a warning on a quarter of the grid for nothing.
      if (present && challenge > planned) {
        invertedMonths += 1;
      }
      rowPlanned += planned;
      rowChallenge += challenge;
      cells.push({
        month,
        label: monthLabels[monthToIndex(month)] ?? `#${month}`,
        plannedHours: planned,
        challengeHours: challenge,
        present,
      });
    }

    if (missingMonths > 0) {
      incompleteSections += 1;
    }
    invertedCells += invertedMonths;
    plannedTotal += rowPlanned;
    challengeTotal += rowChallenge;

    return {
      sectionId: section.id,
      sectionName: section.name,
      departmentId: section.departmentId,
      departmentName: departmentNames.get(section.departmentId) ?? "（未知部门）",
      cells,
      plannedTotal: rowPlanned,
      challengeTotal: rowChallenge,
      missingMonths,
      invertedMonths,
    };
  });

  return {
    rows,
    monthLabels,
    incompleteSections,
    invertedCells,
    plannedTotal,
    challengeTotal,
  };
}
