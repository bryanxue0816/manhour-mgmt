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
import type { ActualRow, OrgSnapshot } from "@/lib/db/types";

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

function actual(overrides: Partial<ActualRow> & Pick<ActualRow, "sectionId" | "month">): ActualRow {
  return {
    fiscalYearId: FY.id,
    personnelHours: 0,
    overtimeHours: 0,
    totalHours: 0,
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
