// D-233 regression: the dashboard tree must report 实绩 as 折算 + 未撤销调整单.
//
// WHY THIS FILE EXISTS. D-233 migrated the 实绩 screen to the composed read and left the
// dashboard on the raw fold, so a real +1 slip on 财务课 26/08 rendered as 1,073 on
// /actuals and 1,072 on the 看板 at the same moment. Nothing caught it because this layer
// had ZERO tests - buildOrgRoot() is a pure function, which made it the cheapest thing in
// the codebase to test and therefore the thing nobody did.
//
// The gap survived a type change, too: ActualEffectiveRow extends ActualRow, so handing
// effective rows to a consumer that reads `totalHours` compiles, type-checks and returns
// the understated number. That is precisely why these assertions are on VALUES read out of
// the built tree, not on the shape of the input.
//
// Fixtures mirror the shape of the production incident (fold 1072, slip +1, effective 1073)
// with synthesised section names. Real attendance data carries 工号/姓名 and must never
// become test data.

import { describe, expect, it } from "vitest";

import { buildOrgRoot } from "@/lib/db/adapter/org-tree";
import type { ActualEffectiveRow, OrgSnapshot, PlanRow } from "@/lib/db/types";

const FY = "fy-2026";

/** Fiscal month 5 = August (month 1 = April), i.e. months[4] on the frontend. */
const AUG = 5;
const AUG_INDEX = 4;

/** Two departments, three sections - enough to prove the roll-up, small enough to read. */
const SNAPSHOT: OrgSnapshot = {
  departments: [
    {
      id: "d-keiei",
      name: "経営企画部",
      code: "KE",
      sortOrder: 1,
      managerName: null,
      managerEmail: null,
    },
    {
      id: "d-seizo",
      name: "製造部",
      code: "SZ",
      sortOrder: 2,
      managerName: null,
      managerEmail: null,
    },
  ],
  sections: [
    {
      id: "s-zaimu",
      departmentId: "d-keiei",
      name: "財務課",
      sortOrder: 1,
      managerName: null,
      managerEmail: null,
    },
    {
      id: "s-jinji",
      departmentId: "d-keiei",
      name: "人事課",
      sortOrder: 2,
      managerName: null,
      managerEmail: null,
    },
    {
      id: "s-kumitate",
      departmentId: "d-seizo",
      name: "組立課",
      sortOrder: 1,
      managerName: null,
      managerEmail: null,
    },
  ],
};

/**
 * One composed actual row.
 *
 * `effectiveHours` is computed here rather than passed in, so a fixture can never assert a
 * total that the merge itself would not have produced.
 */
function effective(
  sectionId: string,
  month: number,
  totalHours: number,
  adjustmentHours = 0,
): ActualEffectiveRow {
  return {
    sectionId,
    fiscalYearId: FY,
    month,
    // A manual baseline month holds the whole figure in personnelHours (D-198).
    personnelHours: totalHours,
    overtimeHours: 0,
    totalHours,
    source: "fold",
    adjustmentHours,
    effectiveHours: totalHours + adjustmentHours,
    foldChangedSinceAdjustment: false,
  };
}

function plan(sectionId: string, month: number, plannedHours: number): PlanRow {
  return {
    sectionId,
    fiscalYearId: FY,
    month,
    plannedHours,
    challengeHours: plannedHours,
  };
}

/** Reads one section's month out of the built tree by name, not by index. */
function sectionMonth(
  root: ReturnType<typeof buildOrgRoot>,
  deptName: string,
  sectionName: string,
  index: number,
) {
  const dept = root.depts.find((d) => d.name === deptName);
  if (!dept) throw new Error(`dept not found: ${deptName}`);
  const section = dept.sections.find((s) => s.name === sectionName);
  if (!section) throw new Error(`section not found: ${sectionName}`);
  return section.months[index]!;
}

describe("buildOrgRoot - 实绩 reflects adjustment slips", () => {
  it("reports 折算 + 调整单, not the bare fold (the 1072/1073 incident)", () => {
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [],
      actuals: [effective("s-zaimu", AUG, 1072, 1)],
    });

    // The whole defect in one assertion: 1072 here means the tree read totalHours.
    expect(sectionMonth(root, "経営企画部", "財務課", AUG_INDEX).actual).toBe(1073);
  });

  it("equals the fold when the section-month carries no slip", () => {
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [],
      actuals: [effective("s-zaimu", AUG, 1072)],
    });

    expect(sectionMonth(root, "経営企画部", "財務課", AUG_INDEX).actual).toBe(1072);
  });

  it("applies a negative slip downward", () => {
    // A hand tally BELOW the fold is corrected by a negative slip, not a special case.
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [],
      actuals: [effective("s-zaimu", AUG, 965, -45)],
    });

    expect(sectionMonth(root, "経営企画部", "財務課", AUG_INDEX).actual).toBe(920);
  });

  it("carries the adjustment into the 部 and 全公司 roll-ups", () => {
    // Guards the half-fix: correcting the section slot while dept/root keep summing the
    // fold would leave 単月実績 right and 累計実績 wrong - which is how the incident was
    // actually reported (tooltip 1,072 H AND 累計実績 5,152.5 H both stale).
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [],
      actuals: [
        effective("s-zaimu", AUG, 1072, 1),
        effective("s-jinji", AUG, 500, 10),
        effective("s-kumitate", AUG, 300),
      ],
    });

    const keiei = root.depts.find((d) => d.name === "経営企画部")!;
    expect(keiei.months[AUG_INDEX]!.actual).toBe(1583); // 1073 + 510
    expect(root.months[AUG_INDEX]!.actual).toBe(1883); // + 300 untouched
  });

  it("does not leak one section's adjustment into a sibling in the same month", () => {
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [plan("s-jinji", AUG, 480)],
      actuals: [effective("s-zaimu", AUG, 1072, 1), effective("s-jinji", AUG, 500)],
    });

    expect(sectionMonth(root, "経営企画部", "財務課", AUG_INDEX).actual).toBe(1073);
    expect(sectionMonth(root, "経営企画部", "人事課", AUG_INDEX).actual).toBe(500);
    // Plans stay untouched by the actuals path.
    expect(sectionMonth(root, "経営企画部", "人事課", AUG_INDEX).plan).toBe(480);
  });

  it("leaves months with no actual row at zero rather than undefined", () => {
    // Invariant 1: a hole here becomes NaN once calc.ts folds the cumulative line.
    const root = buildOrgRoot({
      snapshot: SNAPSHOT,
      plans: [],
      actuals: [effective("s-zaimu", AUG, 1072, 1)],
    });

    const months = sectionMonth(root, "経営企画部", "財務課", 0);
    expect(months.actual).toBe(0);
    expect(root.months.every((m) => Number.isFinite(m.actual))).toBe(true);
  });
});
