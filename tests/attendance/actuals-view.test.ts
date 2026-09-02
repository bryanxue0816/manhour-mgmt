// D-119 / T4F acceptance: folding stored aggregates into the /actuals view.
//
// Pure shape logic, so the tests run against object literals - no database, no
// Prisma, no fixture files. `buildActualsView` is prisma-free precisely so this
// file can stay that way; the same reasoning that put `aliasKey` in
// `lib/db/section-key.ts`.
//
// Two things under test that are easy to get wrong and impossible to see on
// screen: an unimported month and a genuine zero both render as "0" (only
// `present` tells them apart), and `overtimeHours` is legitimately negative when
// compensatory leave exceeds overtime - so totals must not be clamped anywhere.

import { describe, expect, it } from "vitest";

import { buildActualsView } from "@/lib/attendance/actuals-view";
import type { ActualEffectiveRow, OrgSnapshot } from "@/lib/db/types";

const FY = { id: "fy-2026", year: 2026 };

/** Two departments, three sections - enough to check grouping and row order. */
const SNAPSHOT: OrgSnapshot = {
  departments: [
    { id: "dept-qa", name: "品质保证部", code: null, sortOrder: 4, managerName: null, managerEmail: null },
    { id: "dept-mfg", name: "制造部", code: null, sortOrder: 7, managerName: null, managerEmail: null },
  ],
  sections: [
    { id: "sec-inspect", departmentId: "dept-qa", name: "检查课", sortOrder: 1, managerName: null, managerEmail: null },
    { id: "sec-quality", departmentId: "dept-qa", name: "品质课", sortOrder: 2, managerName: null, managerEmail: null },
    { id: "sec-assy", departmentId: "dept-mfg", name: "组装课", sortOrder: 1, managerName: null, managerEmail: null },
  ],
};

/**
 * One merged row - what findEffectiveActualsByFiscalYear() hands the view (D-233).
 *
 * `effectiveHours` is DERIVED from the two parts rather than defaulted to 0, because that
 * is the invariant mergeActualAdjustments() guarantees and a fixture that broke it would
 * make the view look correct while testing a state the database cannot produce. A case
 * that deliberately wants them inconsistent still overrides it explicitly - `...overrides`
 * comes last.
 */
function actual(
  overrides: Partial<ActualEffectiveRow> & Pick<ActualEffectiveRow, "sectionId" | "month">,
): ActualEffectiveRow {
  const totalHours = overrides.totalHours ?? 0;
  const adjustmentHours = overrides.adjustmentHours ?? 0;
  return {
    fiscalYearId: FY.id,
    personnelHours: 0,
    overtimeHours: 0,
    totalHours,
    adjustmentHours,
    effectiveHours: totalHours + adjustmentHours,
    foldChangedSinceAdjustment: false,
    // Attendance fold is the default a row gets when the test says nothing about
    // provenance; the manual baseline is opted into explicitly (D-198).
    source: "fold",
    ...overrides,
  };
}

describe("buildActualsView - shape", () => {
  it("returns one row per section, in snapshot order", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.rows.map((row) => row.sectionId)).toEqual([
      "sec-inspect",
      "sec-quality",
      "sec-assy",
    ]);
  });

  it("gives every row exactly 12 cells, month 1 first", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    for (const row of view.rows) {
      expect(row.cells).toHaveLength(12);
      expect(row.cells.map((cell) => cell.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
  });

  it("labels month 1 as April of the fiscal year and month 12 as the following March", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.monthLabels).toHaveLength(12);
    expect(view.monthLabels[0]).toBe("26/04");
    expect(view.monthLabels[11]).toBe("27/03");
  });

  it("carries the department name onto each row for grouping", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.rows[0]?.departmentName).toBe("品质保证部");
    expect(view.rows[2]?.departmentName).toBe("制造部");
  });
});

describe("buildActualsView - present flag", () => {
  it("marks every cell absent when the year has no actuals", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.rows.every((row) => row.cells.every((cell) => !cell.present))).toBe(true);
    expect(view.sectionsWithData).toBe(0);
    expect(view.monthsWithData).toEqual([]);
    expect(view.latestMonthWithData).toBeNull();
  });

  it("distinguishes a stored zero from a missing month", () => {
    // The whole reason `present` exists: both cells below read "0" on screen, but
    // the first was imported and reported nothing while the second was never imported.
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 4 })],
      FY,
    );

    const cells = view.rows[0]?.cells ?? [];
    expect(cells[3]?.present).toBe(true);
    expect(cells[3]?.totalHours).toBe(0);
    expect(cells[4]?.present).toBe(false);
    expect(cells[4]?.totalHours).toBe(0);
  });

  it("counts months with data per row without counting untouched months", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 1, totalHours: 10 }),
        actual({ sectionId: "sec-inspect", month: 4, totalHours: 20 }),
      ],
      FY,
    );

    expect(view.rows[0]?.monthsWithData).toBe(2);
    expect(view.rows[1]?.monthsWithData).toBe(0);
  });
});

describe("buildActualsView - totals", () => {
  it("sums a row across months and the grand total across sections", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 1, personnelHours: 100, overtimeHours: 10, totalHours: 110 }),
        actual({ sectionId: "sec-inspect", month: 2, personnelHours: 200, overtimeHours: 20, totalHours: 220 }),
        actual({ sectionId: "sec-assy", month: 1, personnelHours: 300, overtimeHours: 30, totalHours: 330 }),
      ],
      FY,
    );

    expect(view.rows[0]?.personnelTotal).toBe(300);
    expect(view.rows[0]?.overtimeTotal).toBe(30);
    expect(view.rows[0]?.total).toBe(330);
    expect(view.personnelTotal).toBe(600);
    expect(view.overtimeTotal).toBe(60);
    expect(view.total).toBe(660);
    expect(view.sectionsWithData).toBe(2);
  });

  it("reads the stored total instead of re-adding the two parts", () => {
    // calc.ts owns the D-110 formula (compensatory leave can drive 总工时 to 0 while
    // 人员工时 stays positive). Re-adding here would give 8 + -8 = 0 by luck on this
    // row and the wrong answer on the next formula change.
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({
          sectionId: "sec-inspect",
          month: 1,
          personnelHours: 8,
          overtimeHours: -8,
          totalHours: 0,
        }),
      ],
      FY,
    );

    expect(view.rows[0]?.cells[0]?.totalHours).toBe(0);
    expect(view.rows[0]?.cells[0]?.personnelHours).toBe(8);
  });

  it("keeps negative overtime negative in every total", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 1, personnelHours: 8, overtimeHours: -8, totalHours: 0 }),
        actual({ sectionId: "sec-assy", month: 1, personnelHours: 8, overtimeHours: -4, totalHours: 4 }),
      ],
      FY,
    );

    expect(view.overtimeTotal).toBe(-12);
    expect(view.monthTotals[0]?.overtimeHours).toBe(-12);
  });
});

describe("buildActualsView - month footers", () => {
  it("returns 12 footers even for an empty year", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.monthTotals).toHaveLength(12);
    expect(view.monthTotals.every((month) => month.sectionsWithData === 0)).toBe(true);
  });

  it("sums one month across sections and counts the reporting sections", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 4, personnelHours: 100, totalHours: 100 }),
        actual({ sectionId: "sec-quality", month: 4, personnelHours: 50, totalHours: 50 }),
      ],
      FY,
    );

    expect(view.monthTotals[3]?.totalHours).toBe(150);
    expect(view.monthTotals[3]?.sectionsWithData).toBe(2);
    // A stored zero still counts as reported - it is data, not a gap.
    expect(view.monthTotals[0]?.sectionsWithData).toBe(0);
  });

  it("aligns footer labels with the column headers", () => {
    const view = buildActualsView(SNAPSHOT, [], FY);

    expect(view.monthTotals.map((month) => month.label)).toEqual(view.monthLabels);
  });
});

describe("buildActualsView - latestMonthWithData", () => {
  it("lists months with data ascending regardless of input order", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 9, totalHours: 1 }),
        actual({ sectionId: "sec-assy", month: 2, totalHours: 1 }),
        actual({ sectionId: "sec-quality", month: 4, totalHours: 1 }),
      ],
      FY,
    );

    expect(view.monthsWithData).toEqual([2, 4, 9]);
    expect(view.latestMonthWithData).toBe(9);
  });

  it("treats a stored zero as data, so the focus month is not skipped", () => {
    // A month imported with all-zero hours is still the newest month on record.
    // Skipping it would point the unattributed banner at an older month.
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 1, totalHours: 500 }),
        actual({ sectionId: "sec-inspect", month: 2 }),
      ],
      FY,
    );

    expect(view.latestMonthWithData).toBe(2);
  });

  it("handles month 12 as the latest without falling off the array", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 12, totalHours: 1 })],
      FY,
    );

    expect(view.latestMonthWithData).toBe(12);
    expect(view.monthTotals[11]?.sectionsWithData).toBe(1);
  });
});

describe("buildActualsView - guards", () => {
  it("throws when a row belongs to another fiscal year", () => {
    expect(() =>
      buildActualsView(
        SNAPSHOT,
        [actual({ sectionId: "sec-inspect", month: 1, fiscalYearId: "fy-2027" })],
        FY,
      ),
    ).toThrow(/fiscal year/);
  });

  it("names both years in the error so the caller can see which query was wrong", () => {
    let message = "";
    try {
      buildActualsView(
        SNAPSHOT,
        [actual({ sectionId: "sec-inspect", month: 1, fiscalYearId: "fy-2027" })],
        FY,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("fy-2027");
    expect(message).toContain("fy-2026");
  });

  it("throws on an aggregate for a section missing from the snapshot", () => {
    // Silently dropping it would hide hours on the one screen that must account
    // for all of them.
    expect(() =>
      buildActualsView(SNAPSHOT, [actual({ sectionId: "sec-ghost", month: 1 })], FY),
    ).toThrow(/unknown section sec-ghost/);
  });

  it.each([0, 13, -1, 1.5, Number.NaN])("throws on out-of-range month %s", (month) => {
    expect(() =>
      buildActualsView(SNAPSHOT, [actual({ sectionId: "sec-inspect", month })], FY),
    ).toThrow(/outside 1\.\.12/);
  });
});

describe("buildActualsView - manual baseline provenance (D-198)", () => {
  /** One month back-filled by hand: whole month in totalHours, split unavailable. */
  const MANUAL = actual({
    sectionId: "sec-inspect",
    month: 1,
    source: "manual",
    personnelHours: 0,
    overtimeHours: 0,
    totalHours: 1310.5,
  });

  it("marks the cell whose row was typed in by hand", () => {
    const view = buildActualsView(SNAPSHOT, [MANUAL], FY);

    const cell = view.rows[0]?.cells[0];
    expect(cell?.isManualBaseline).toBe(true);
    expect(cell?.present).toBe(true);
    expect(cell?.totalHours).toBe(1310.5);
  });

  it("leaves an attendance-folded cell unmarked", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 2, totalHours: 900, source: "fold" })],
      FY,
    );

    expect(view.rows[0]?.cells[1]?.isManualBaseline).toBe(false);
  });

  it("does not mark an absent cell", () => {
    // "Nothing was entered" is not a provenance. Marking it would make the tooltip
    // claim a source for a figure that does not exist.
    const view = buildActualsView(SNAPSHOT, [], FY);

    for (const cell of view.rows[0]?.cells ?? []) {
      expect(cell.isManualBaseline).toBe(false);
      expect(cell.present).toBe(false);
    }
  });

  it("flags the column footer when any section in that month is manual", () => {
    // Any-not-all: one manual row already makes the personnel/overtime column sums an
    // undercount, so the caveat has to show while the rest of the column is folded.
    const view = buildActualsView(
      SNAPSHOT,
      [MANUAL, actual({ sectionId: "sec-assy", month: 1, personnelHours: 700, totalHours: 800 })],
      FY,
    );

    expect(view.monthTotals[0]?.hasManualBaseline).toBe(true);
    expect(view.monthTotals[0]?.sectionsWithData).toBe(2);
  });

  it("leaves the footer unflagged for an all-folded month", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 3, totalHours: 500 })],
      FY,
    );

    expect(view.monthTotals[2]?.hasManualBaseline).toBe(false);
  });

  it("lists manual months ascending, derived from the rows", () => {
    // The UI footnote reads this instead of a literal "4~7 月", so importing 8月 the
    // same way updates the wording by itself rather than turning it into a lie.
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 4, source: "manual", totalHours: 10 }),
        actual({ sectionId: "sec-inspect", month: 1, source: "manual", totalHours: 20 }),
        actual({ sectionId: "sec-assy", month: 2, totalHours: 30 }),
      ],
      FY,
    );

    expect(view.manualBaselineMonths).toEqual([1, 4]);
  });

  it("reports no manual months when every figure came from attendance", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 1, totalHours: 100 })],
      FY,
    );

    expect(view.manualBaselineMonths).toEqual([]);
  });

  it("still counts a manual month as a month with data", () => {
    // The marker changes how the figure is READ, never whether it exists - a manual
    // month that dropped out of monthsWithData would vanish from the month tabs and
    // the dashboard would treat it as un-imported.
    const view = buildActualsView(SNAPSHOT, [MANUAL], FY);

    expect(view.monthsWithData).toEqual([1]);
    expect(view.latestMonthWithData).toBe(1);
    expect(view.sectionsWithData).toBe(1);
    expect(view.total).toBe(1310.5);
  });
});

describe("buildActualsView - adjustment slips (D-233)", () => {
  /** 8月 as production actually has it: fold from 26-31日 only, rest hand-tallied. */
  const AUG_FOLD = 6870;
  const AUG_SLIP = 24500;

  it("carries fold, adjustment and effective side by side without collapsing them", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({
          sectionId: "sec-inspect",
          month: 5,
          personnelHours: 6000,
          overtimeHours: 870,
          totalHours: AUG_FOLD,
          adjustmentHours: AUG_SLIP,
        }),
      ],
      FY,
    );

    const cell = view.rows[0]?.cells[4];
    // The fold must survive intact: it is what the attendance panels reconcile against,
    // and it is the base the drift check compares future re-folds to.
    expect(cell?.totalHours).toBe(AUG_FOLD);
    expect(cell?.adjustmentHours).toBe(AUG_SLIP);
    expect(cell?.effectiveHours).toBe(AUG_FOLD + AUG_SLIP);
    // 人员/加班 belong to the fold alone - a slip carries only 总工时 (user ruling
    // 「只有總工時」), so adding it must not inflate either part.
    expect(cell?.personnelHours).toBe(6000);
    expect(cell?.overtimeHours).toBe(870);
  });

  it("takes effectiveHours from the merge instead of re-adding the parts", () => {
    // Same reasoning as the totalHours case above: mergeActualAdjustments() owns the sum
    // and asserts it is finite. If this view ever recomputes it, the two layers can
    // disagree and the screen would show a number no repository produced.
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({
          sectionId: "sec-inspect",
          month: 1,
          totalHours: 100,
          adjustmentHours: 50,
          effectiveHours: 999,
        }),
      ],
      FY,
    );

    expect(view.rows[0]?.cells[0]?.effectiveHours).toBe(999);
    // Row, month footer and grand total must all inherit the merge's number. Asserting
    // only the row would let the grand total quietly go back to 折算 + 调整 (150 here),
    // which is the same value in healthy data and a different one whenever it matters.
    expect(view.rows[0]?.effectiveTotal).toBe(999);
    expect(view.monthTotals[0]?.effectiveHours).toBe(999);
    expect(view.effectiveTotal).toBe(999);
  });

  it("keeps row, month and grand totals separated into fold / adjustment / effective", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 1, totalHours: 100, adjustmentHours: 20 }),
        actual({ sectionId: "sec-inspect", month: 2, totalHours: 200 }),
        actual({ sectionId: "sec-assy", month: 1, totalHours: 300, adjustmentHours: -50 }),
      ],
      FY,
    );

    expect(view.rows[0]?.total).toBe(300);
    expect(view.rows[0]?.adjustmentTotal).toBe(20);
    expect(view.rows[0]?.effectiveTotal).toBe(320);

    expect(view.monthTotals[0]?.totalHours).toBe(400);
    expect(view.monthTotals[0]?.adjustmentHours).toBe(-30);
    expect(view.monthTotals[0]?.effectiveHours).toBe(370);

    expect(view.total).toBe(600);
    expect(view.adjustmentTotal).toBe(-30);
    expect(view.effectiveTotal).toBe(570);
  });

  it("keeps a negative adjustment negative in every total", () => {
    // The mirror of the negative-overtime case: a downward correction (系统抓多了) is a
    // legitimate slip, and clamping it anywhere would silently restore the over-count.
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 1, totalHours: 500, adjustmentHours: -120 })],
      FY,
    );

    expect(view.rows[0]?.cells[0]?.adjustmentHours).toBe(-120);
    expect(view.rows[0]?.adjustmentTotal).toBe(-120);
    expect(view.monthTotals[0]?.adjustmentHours).toBe(-120);
    expect(view.adjustmentTotal).toBe(-120);
    expect(view.effectiveTotal).toBe(380);
  });

  it("marks a slip-only section-month as present so it renders instead of showing 尚未导入", () => {
    // No Actual row exists for this (課, 月) - the merge synthesised the row from the slip
    // alone. Treating it as absent would hide hand-tallied hours that ARE counted in every
    // total, which is the same class of bug the unattributed banner exists to prevent.
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-quality", month: 5, totalHours: 0, adjustmentHours: 1200 })],
      FY,
    );

    const cell = view.rows[1]?.cells[4];
    expect(cell?.present).toBe(true);
    expect(cell?.totalHours).toBe(0);
    expect(cell?.effectiveHours).toBe(1200);
    expect(view.monthsWithData).toEqual([5]);
    expect(view.sectionsWithData).toBe(1);
  });

  it("defaults untouched cells to zero adjustment and effective === fold", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [actual({ sectionId: "sec-inspect", month: 1, totalHours: 100 })],
      FY,
    );

    // The reported cell.
    expect(view.rows[0]?.cells[0]?.adjustmentHours).toBe(0);
    expect(view.rows[0]?.cells[0]?.effectiveHours).toBe(100);
    // An unreported one - `stored` is undefined there, and the fallbacks must not leak
    // NaN into the totals.
    expect(view.rows[0]?.cells[1]?.adjustmentHours).toBe(0);
    expect(view.rows[0]?.cells[1]?.effectiveHours).toBe(0);
    expect(view.effectiveTotal).toBe(100);
  });

  it("names every drifted section-month in row order", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({
          sectionId: "sec-assy",
          month: 5,
          totalHours: 31000,
          adjustmentHours: AUG_SLIP,
          foldChangedSinceAdjustment: true,
        }),
        actual({
          sectionId: "sec-inspect",
          month: 5,
          totalHours: 31000,
          adjustmentHours: AUG_SLIP,
          foldChangedSinceAdjustment: true,
        }),
        actual({ sectionId: "sec-inspect", month: 4, totalHours: 100, adjustmentHours: 10 }),
      ],
      FY,
    );

    // Row order, not input order: the banner sits above a grid sorted by 部/課, and a
    // list that jumps around sends the reader hunting.
    // The label comes from the view's own month headers rather than a literal: the banner
    // and the column it points at have to say the same thing, and hardcoding the format
    // here would let them drift apart without a failing test.
    const augustLabel = view.monthLabels[4];
    expect(view.foldDriftCells).toEqual([
      { sectionId: "sec-inspect", sectionName: "检查课", month: 5, label: augustLabel },
      { sectionId: "sec-assy", sectionName: "组装课", month: 5, label: augustLabel },
    ]);
  });

  it("leaves foldDriftCells empty when nothing drifted", () => {
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({ sectionId: "sec-inspect", month: 5, totalHours: AUG_FOLD, adjustmentHours: AUG_SLIP }),
        actual({ sectionId: "sec-assy", month: 1, totalHours: 100 }),
      ],
      FY,
    );

    expect(view.foldDriftCells).toEqual([]);
  });

  it("flags drift on a cell whose slips net to zero", () => {
    // adjustmentHours === 0 does not mean "no slip". Two live slips of +300 and -300 leave
    // the figure untouched, but the fold underneath them can still have moved - and if it
    // did, the pair may now be double-counting in both directions.
    const view = buildActualsView(
      SNAPSHOT,
      [
        actual({
          sectionId: "sec-inspect",
          month: 5,
          totalHours: 31000,
          adjustmentHours: 0,
          foldChangedSinceAdjustment: true,
        }),
      ],
      FY,
    );

    expect(view.foldDriftCells).toHaveLength(1);
    expect(view.rows[0]?.cells[4]?.effectiveHours).toBe(31000);
  });

  it("throws when a slip references a section the org snapshot no longer has", () => {
    // The guard already covered a deleted section on a folded row; a slip reaches the view
    // through the same merged shape, so it has to fail the same way rather than be dropped.
    expect(() =>
      buildActualsView(
        SNAPSHOT,
        [actual({ sectionId: "sec-deleted", month: 5, totalHours: 0, adjustmentHours: 800 })],
        FY,
      ),
    ).toThrow(/sec-deleted/);
  });
});
