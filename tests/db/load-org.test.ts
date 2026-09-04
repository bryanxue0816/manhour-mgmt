// D-233 regression: loadOrgRoot() must read through the COMPOSED actual repository.
//
// org-tree.test.ts proves buildOrgRoot() honours effectiveHours. That is necessary and not
// sufficient: the dashboard was wrong because the WIRING fed it plain folded rows, and no
// type error announced it - ActualEffectiveRow extends ActualRow, so the raw repository's
// output remains assignable to a consumer expecting the composed one.
//
// So this file locks the wiring itself. The negative assertion matters as much as the
// positive one: findActualsByFiscalYear() must not be reachable from the dashboard path,
// because it is the right answer only for the attendance-provenance panels (what did the
// import itself produce?) and the wrong one for a total a manager reads.
//
// prisma is stubbed to {} - every repository this module touches is mocked, so a real
// client would only widen the blast radius of a failure.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActualEffectiveRow, OrgSnapshot } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({
  loadOrgSnapshot: vi.fn(),
  findPlansByFiscalYear: vi.fn(),
  findActualsByFiscalYear: vi.fn(),
  findEffectiveActualsByFiscalYear: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/db/org.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/org.repo")>()),
  loadOrgSnapshot: mocks.loadOrgSnapshot,
}));

vi.mock("@/lib/db/plan.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/plan.repo")>()),
  findPlansByFiscalYear: mocks.findPlansByFiscalYear,
}));

vi.mock("@/lib/db/actual.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/actual.repo")>()),
  findActualsByFiscalYear: mocks.findActualsByFiscalYear,
}));

vi.mock("@/lib/db/actual-effective.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/actual-effective.repo")>()),
  findEffectiveActualsByFiscalYear: mocks.findEffectiveActualsByFiscalYear,
}));

const { loadOrgRoot } = await import("@/lib/db/adapter/load-org");

const FY = "fy-2026";
/** Fiscal month 5 = August (month 1 = April), i.e. months[4] on the frontend. */
const AUG = 5;
const AUG_INDEX = 4;

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
  ],
};

/** The production incident, as data: fold 1072, one +1 slip, effective 1073. */
const ADJUSTED_ROW: ActualEffectiveRow = {
  sectionId: "s-zaimu",
  fiscalYearId: FY,
  month: AUG,
  personnelHours: 1072,
  overtimeHours: 0,
  totalHours: 1072,
  source: "fold",
  adjustmentHours: 1,
  effectiveHours: 1073,
  foldChangedSinceAdjustment: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadOrgSnapshot.mockResolvedValue(SNAPSHOT);
  mocks.findPlansByFiscalYear.mockResolvedValue([]);
  // Returns the UNADJUSTED fold. If the dashboard ever reaches this, the number it renders
  // is 1072 and the assertion below says so.
  mocks.findActualsByFiscalYear.mockResolvedValue([
    { ...ADJUSTED_ROW, adjustmentHours: undefined, effectiveHours: undefined },
  ]);
  mocks.findEffectiveActualsByFiscalYear.mockResolvedValue({
    rows: [ADJUSTED_ROW],
    adjustedMonths: [AUG],
  });
});

describe("loadOrgRoot - composed actual wiring", () => {
  it("renders 实绩 with the slip folded in", async () => {
    const root = await loadOrgRoot(FY);

    const section = root.depts[0]!.sections[0]!;
    expect(section.months[AUG_INDEX]!.actual).toBe(1073);
    // Roll-ups too: 単月 right and 累計 wrong was half the reported incident.
    expect(root.depts[0]!.months[AUG_INDEX]!.actual).toBe(1073);
    expect(root.months[AUG_INDEX]!.actual).toBe(1073);
  });

  it("goes through findEffectiveActualsByFiscalYear", async () => {
    await loadOrgRoot(FY);

    expect(mocks.findEffectiveActualsByFiscalYear).toHaveBeenCalledTimes(1);
    expect(mocks.findEffectiveActualsByFiscalYear).toHaveBeenCalledWith(FY);
  });

  it("never calls the raw fold repository from the dashboard path", async () => {
    await loadOrgRoot(FY);

    // The composed repository calls it internally, inside one transaction - but it is
    // mocked here, so any call seen at this level came from load-org.ts itself.
    expect(mocks.findActualsByFiscalYear).not.toHaveBeenCalled();
  });

  it("unwraps EffectiveActuals rather than passing the envelope down", async () => {
    // findEffectiveActualsByFiscalYear resolves to { rows, adjustedMonths }, not an array.
    // Forgetting `.rows` yields a silently EMPTY tree - twelve zeroed months, no throw.
    const root = await loadOrgRoot(FY);

    expect(root.months.some((m) => m.actual !== 0)).toBe(true);
  });

  it("still honours the root label", async () => {
    const root = await loadOrgRoot(FY, "全公司");

    expect(root.name).toBe("全公司");
  });
});
