// D-233 acceptance: the composed 实绩 read - folded rows plus un-revoked slips.
//
// The arithmetic itself is covered in actual-adjustment.test.ts against
// mergeActualAdjustments() directly. What is only testable here is the WIRING: that both
// tables are read from one snapshot, that the slip filter is applied in SQL, and that the
// merge's flags survive the trip to the caller. Each of those fails silently - a wrong
// total renders exactly as convincingly as a right one.
//
// Fixtures are synthesised. The real attendance exports carry 工号 and 姓名 and must never
// become test data. The 6870 / 31000 pair is the shape of the real 8月 hazard (26-31日 only,
// then the 1-25日 detail arriving late), not real hours.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActualAdjustmentRow, ActualRow } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({
  actualFindMany: vi.fn(),
  adjustmentFindMany: vi.fn(),
  transaction: vi.fn(),
}));

// Neither table is reachable outside the transaction: `prisma` here exposes ONLY
// $transaction. If either read is ever moved off the transaction client, it throws a
// TypeError here rather than passing while comparing a slip's recorded base against a
// `totalHours` from a different instant - a false drift warning nothing in the app could
// distinguish from a real one. Enforced structurally because an assertion on "same client"
// is easy to delete without noticing what it protected.
vi.mock("@/lib/prisma", () => {
  const tx = {
    actual: { findMany: mocks.actualFindMany },
    actualAdjustment: { findMany: mocks.adjustmentFindMany },
  };
  mocks.transaction.mockImplementation((run: (client: typeof tx) => unknown) => run(tx));
  return { prisma: { $transaction: mocks.transaction } };
});

import { findEffectiveActualsByFiscalYear } from "@/lib/db/actual-effective.repo";

const FY = "fy-2026";

/** One folded row. `personnelHours` carries the whole total so the D-110 invariant holds. */
function actual(sectionId: string, month: number, totalHours: number): ActualRow {
  return {
    sectionId,
    fiscalYearId: FY,
    month,
    personnelHours: totalHours,
    overtimeHours: 0,
    totalHours,
    source: "fold",
  };
}

/** One slip. `foldHoursAtEntry` defaults to null - "base not recorded", drift check skipped. */
function slip(
  id: string,
  sectionId: string,
  month: number,
  hours: number,
  overrides: Partial<ActualAdjustmentRow> = {},
): ActualAdjustmentRow {
  return {
    id,
    sectionId,
    fiscalYearId: FY,
    month,
    hours,
    reason: "8月1-25日 按课合计补录",
    foldHoursAtEntry: null,
    changedBy: "u-admin",
    changedAt: new Date("2026-09-01T00:00:00.000Z"),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function given(actuals: ActualRow[], slips: ActualAdjustmentRow[]): void {
  mocks.actualFindMany.mockResolvedValue(actuals);
  mocks.adjustmentFindMany.mockResolvedValue(slips);
}

beforeEach(() => {
  mocks.actualFindMany.mockReset();
  mocks.adjustmentFindMany.mockReset();
  mocks.transaction.mockClear();
  given([], []);
});

describe("findEffectiveActualsByFiscalYear", () => {
  it("reads both tables inside ONE transaction", async () => {
    await findEffectiveActualsByFiscalYear(FY);

    // Two separate $transaction calls would be two snapshots, which is the same race as no
    // transaction at all - hence the count, not just "was it used".
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.actualFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.adjustmentFindMany).toHaveBeenCalledTimes(1);
  });

  it("scopes both reads to the fiscal year, and slips to un-revoked, in SQL", async () => {
    await findEffectiveActualsByFiscalYear(FY);

    expect(mocks.actualFindMany.mock.calls[0]?.[0]?.where).toEqual({ fiscalYearId: FY });
    expect(mocks.adjustmentFindMany.mock.calls[0]?.[0]?.where).toEqual({
      fiscalYearId: FY,
      revokedAt: null,
    });
  });

  it("adds slips to the fold without touching totalHours", async () => {
    given([actual("s1", 5, 6870)], [slip("a1", "s1", 5, 24500)]);

    const { rows } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows).toHaveLength(1);
    // totalHours stays the fold on purpose: an un-migrated read point then shows a visibly
    // low number rather than a plausible blend nobody would question.
    expect(rows[0]?.totalHours).toBe(6870);
    expect(rows[0]?.adjustmentHours).toBe(24500);
    expect(rows[0]?.effectiveHours).toBe(31370);
  });

  it("surfaces a section-month that exists only as a slip", async () => {
    given([], [slip("a1", "s9", 4, 1200)]);

    const { rows } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectionId).toBe("s9");
    expect(rows[0]?.totalHours).toBe(0);
    expect(rows[0]?.effectiveHours).toBe(1200);
    // No third vocabulary word for a virtual row - "fold" keeps every `source ===` test on
    // the read side answering what it already answered.
    expect(rows[0]?.source).toBe("fold");
  });

  it("reports a month as adjusted even when its slips net to zero", async () => {
    // The reason adjustedMonths counts SLIPS instead of testing adjustmentHours !== 0. Both
    // slips are live, the figures on screen came from a hand tally, and a sum-driven
    // footnote would call the month untouched.
    given(
      [actual("s1", 5, 6870)],
      [slip("a1", "s1", 5, 300), slip("a2", "s1", 5, -300)],
    );

    const { rows, adjustedMonths } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows[0]?.adjustmentHours).toBe(0);
    expect(rows[0]?.effectiveHours).toBe(6870);
    expect(adjustedMonths).toEqual([5]);
  });

  it("lists adjusted months ascending and only once per month", async () => {
    given(
      [],
      [slip("a1", "s2", 8, 10), slip("a2", "s1", 5, 10), slip("a3", "s3", 5, 10)],
    );

    const { adjustedMonths } = await findEffectiveActualsByFiscalYear(FY);

    expect(adjustedMonths).toEqual([5, 8]);
  });

  it("carries the drift flag through to the caller", async () => {
    // The 8月 hazard: the slip was written against a 6870 base, then the 1-25日 detail
    // landed and the fold rebuilt to ~31000. The slip is still being added on top.
    given(
      [actual("s1", 5, 31000)],
      [slip("a1", "s1", 5, 24500, { foldHoursAtEntry: 6870 })],
    );

    const { rows } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
    // Suspect, not wrong: nothing is rescaled or dropped. The screen warns, a human decides.
    expect(rows[0]?.effectiveHours).toBe(55500);
  });

  it("leaves the flag down when the fold has not moved", async () => {
    given(
      [actual("s1", 5, 6870)],
      [slip("a1", "s1", 5, 24500, { foldHoursAtEntry: 6870 })],
    );

    const { rows } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("orders rows by section then month", async () => {
    given(
      [actual("s2", 4, 100), actual("s1", 5, 100)],
      [slip("a1", "s1", 4, 10)],
    );

    const { rows } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows.map((row) => `${row.sectionId}/${row.month}`)).toEqual([
      "s1/4",
      "s1/5",
      "s2/4",
    ]);
  });

  it("returns an empty result set for a year with neither folds nor slips", async () => {
    const { rows, adjustedMonths } = await findEffectiveActualsByFiscalYear(FY);

    expect(rows).toEqual([]);
    expect(adjustedMonths).toEqual([]);
  });
});
