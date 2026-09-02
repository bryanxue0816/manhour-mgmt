// D-233 acceptance: adjustment slips, and the arithmetic that folds them into 实绩.
//
// Every case here corresponds to a failure that produces NO error - a wrong number on a
// chart that renders perfectly, or a section that quietly vanishes from a total. That is
// the whole reason this suite is dense: none of these would be caught by running the app
// and looking at it.
//
// Fixtures are entirely synthesised. The real attendance exports carry 工号 and 姓名, and
// must never become test data.
//
// The repo half mocks `@/lib/prisma`, which otherwise builds a better-sqlite3 client at
// module load - same approach as actual-baseline.test.ts. The fakes count calls rather
// than emulating storage: what these assertions are about is whether a write was attempted
// at all, and with which arguments.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { adjustedMonths, mergeActualAdjustments } from "@/lib/db/actual-merge";
import type { ActualAdjustmentRow, ActualRow } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  actualFindMany: vi.fn(),
}));

// The fold-base read is reachable ONLY through the transaction client: `prisma.actual` is
// deliberately left undefined at the top level. If a writer ever reads the base outside the
// transaction it throws here instead of quietly recording a base from a different instant -
// the race readFoldBases() exists to close, enforced structurally rather than by assertion.
vi.mock("@/lib/prisma", () => {
  const actualAdjustment = {
    create: mocks.create,
    createMany: mocks.createMany,
    updateMany: mocks.updateMany,
    findMany: mocks.findMany,
    count: mocks.count,
  };
  const tx = { actualAdjustment, actual: { findMany: mocks.actualFindMany } };
  return {
    prisma: {
      actualAdjustment,
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    },
  };
});

import {
  createActualAdjustment,
  createActualAdjustmentsBulk,
  findActiveAdjustmentsByFiscalYear,
  revokeActualAdjustment,
} from "@/lib/db/actual-adjustment.repo";

const FY = "fy-2026";

/** One folded row. `personnelHours` carries the whole total so the invariant holds. */
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

/**
 * One slip. Overrides let a case set `revokedAt` or move it to another fiscal year.
 *
 * `foldHoursAtEntry` defaults to null - "base not recorded", which the drift check skips.
 * The arithmetic cases therefore stay about arithmetic, and the drift cases state the base
 * they mean explicitly instead of inheriting one.
 */
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
    reason: "8月1-25日按课合计补录",
    foldHoursAtEntry: null,
    changedBy: "admin",
    changedAt: new Date("2026-09-01T01:00:00Z"),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

// --------------------------------------------------------------------------------
// 1. mergeActualAdjustments - the arithmetic
// --------------------------------------------------------------------------------

describe("mergeActualAdjustments", () => {
  it("leaves rows untouched when there are no slips", () => {
    // The state the table ships in. Phase 2 wires this into the read path while the table
    // is still empty, so "changes nothing" is the deployment safety property.
    const rows = mergeActualAdjustments([actual("sec-a", 5, 100)], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalHours).toBe(100);
    expect(rows[0]?.adjustmentHours).toBe(0);
    expect(rows[0]?.effectiveHours).toBe(100);
  });

  it("keeps totalHours as the folded figure and reports the sum separately", () => {
    // The core contract: `totalHours` is NOT blended. A read point that was never migrated
    // shows 100 (understated, noticeable) rather than a plausible-but-wrong blend.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100)],
      [slip("adj-1", "sec-a", 5, 40)],
    );

    expect(rows[0]?.totalHours).toBe(100);
    expect(rows[0]?.adjustmentHours).toBe(40);
    expect(rows[0]?.effectiveHours).toBe(140);
    // personnelHours + overtimeHours === totalHours must still hold.
    expect((rows[0]?.personnelHours ?? 0) + (rows[0]?.overtimeHours ?? 0)).toBe(
      rows[0]?.totalHours,
    );
  });

  it("materialises a row for a section-month that has no folded row at all", () => {
    // 8月's actual shape for a section whose 1-25 arrived as a 課 total and whose 26-31
    // detail was never imported. Iterating `Actual` alone drops this section from the
    // company total with no error anywhere.
    const rows = mergeActualAdjustments([], [slip("adj-1", "sec-b", 5, 320)]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectionId).toBe("sec-b");
    expect(rows[0]?.totalHours).toBe(0);
    expect(rows[0]?.personnelHours).toBe(0);
    expect(rows[0]?.overtimeHours).toBe(0);
    expect(rows[0]?.effectiveHours).toBe(320);
    // "fold" and NOT a third source value: rebuildMonthlyActuals()'s guard must keep
    // answering "not manual" for this row, or a later real import of the month refuses.
    expect(rows[0]?.source).toBe("fold");
  });

  it("accumulates several slips for one section-month instead of overwriting", () => {
    // The table has no unique key on (sectionId, fiscalYearId, month) precisely so this
    // works: a go-live back-fill and a discrepancy found later are two facts.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100)],
      [slip("adj-1", "sec-a", 5, 40), slip("adj-2", "sec-a", 5, 7)],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.adjustmentHours).toBe(47);
    expect(rows[0]?.effectiveHours).toBe(147);
  });

  it("returns exactly one row per section-month", () => {
    // buildOrgRoot() does `slot.actual = row.totalHours` - ASSIGNMENT. Two rows for one
    // section-month means the second silently overwrites the first.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100), actual("sec-a", 6, 90)],
      [
        slip("adj-1", "sec-a", 5, 10),
        slip("adj-2", "sec-a", 5, 10),
        slip("adj-3", "sec-a", 6, 5),
      ],
    );

    const keys = rows.map((row) => `${row.sectionId}|${row.month}`);
    expect(keys).toEqual([...new Set(keys)]);
    expect(rows).toHaveLength(2);
  });

  it("applies a negative slip, correcting a folded figure downwards", () => {
    // A hand tally BELOW the system figure is the same operation as one above it. Clamping
    // to zero would make this direction unrepresentable.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100)],
      [slip("adj-1", "sec-a", 5, -30)],
    );

    expect(rows[0]?.adjustmentHours).toBe(-30);
    expect(rows[0]?.effectiveHours).toBe(70);
  });

  it("allows the net effective figure to go negative rather than clamping", () => {
    // Consistent with D-105: overtime deductions can exceed additions, so a negative
    // actual is real data. Clamping here would rewrite an anomaly into a plausible number.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 10)],
      [slip("adj-1", "sec-a", 5, -50)],
    );

    expect(rows[0]?.effectiveHours).toBe(-40);
  });

  it("ignores revoked slips", () => {
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100)],
      [
        slip("adj-1", "sec-a", 5, 40, { revokedAt: new Date("2026-09-02T00:00:00Z"), revokedBy: "admin" }),
        slip("adj-2", "sec-a", 5, 7),
      ],
    );

    expect(rows[0]?.adjustmentHours).toBe(7);
    expect(rows[0]?.effectiveHours).toBe(107);
  });

  it("keeps a folded row whose slips were all revoked, with a zero adjustment", () => {
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100)],
      [slip("adj-1", "sec-a", 5, 40, { revokedAt: new Date("2026-09-02T00:00:00Z") })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.adjustmentHours).toBe(0);
    expect(rows[0]?.effectiveHours).toBe(100);
  });

  it("does not materialise a virtual row when every slip for it was revoked", () => {
    // There is nothing left to report about that section-month, and inventing a 0-hour row
    // would put a section on screen that contributed nothing.
    const rows = mergeActualAdjustments(
      [],
      [slip("adj-1", "sec-b", 5, 320, { revokedAt: new Date("2026-09-02T00:00:00Z") })],
    );

    expect(rows).toEqual([]);
  });

  it("does not add two fiscal years together", () => {
    // The index key carries fiscalYearId because (sectionId, month) is not unique across
    // the table. Without it, FY2026 month 5 and FY2027 month 5 collide into one figure.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 100), { ...actual("sec-a", 5, 200), fiscalYearId: "fy-2027" }],
      [
        slip("adj-1", "sec-a", 5, 10),
        slip("adj-2", "sec-a", 5, 500, { fiscalYearId: "fy-2027" }),
      ],
    );

    expect(rows).toHaveLength(2);
    const y2026 = rows.find((row) => row.fiscalYearId === FY);
    const y2027 = rows.find((row) => row.fiscalYearId === "fy-2027");
    expect(y2026?.effectiveHours).toBe(110);
    expect(y2027?.effectiveHours).toBe(700);
  });

  it("orders output by (sectionId, month), matching the query it replaces", () => {
    const rows = mergeActualAdjustments(
      [actual("sec-b", 3, 10), actual("sec-a", 7, 10), actual("sec-a", 2, 10)],
      [slip("adj-1", "sec-c", 1, 5)],
    );

    expect(rows.map((row) => `${row.sectionId}:${row.month}`)).toEqual([
      "sec-a:2",
      "sec-a:7",
      "sec-b:3",
      "sec-c:1",
    ]);
  });

  it("refuses a non-finite result instead of letting it poison the roll-up", () => {
    // Infinity in one section blows out its DEPARTMENT and the COMPANY total while healthy
    // siblings still render correctly - far harder to attribute than a page that fails.
    expect(() =>
      mergeActualAdjustments(
        [actual("sec-a", 5, 100)],
        [slip("adj-1", "sec-a", 5, Number.POSITIVE_INFINITY)],
      ),
    ).toThrow(/effectiveHours/);
  });
});

// --------------------------------------------------------------------------------
// 2. foldChangedSinceAdjustment - the double-count alarm
// --------------------------------------------------------------------------------

describe("mergeActualAdjustments - fold drift", () => {
  it("stays quiet when the folded base still matches the slip", () => {
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 6870)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
    expect(rows[0]?.effectiveHours).toBe(30870);
  });

  it("flags the section-month when late detail lifted the folded base", () => {
    // The measured 8月 path: the slip covers 1-25日 as a 課 total against a 6870 base
    // (26-31日 only), then 1-25日's attendance detail arrives and re-folds the month to
    // ~31000. effectiveHours becomes ~55000 - nearly double, with no error anywhere.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 31000)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
    // The hours are NOT auto-corrected: only the reason text can say which figure is right.
    expect(rows[0]?.effectiveHours).toBe(55000);
  });

  it("flags a slip entered before any folded row existed once one appears", () => {
    // The writers store 0, not null, when the section-month has no `Actual` row - so this
    // case, the most dangerous one, is checked rather than exempt.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 1500)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 0 })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
  });

  it("stays quiet for a slip whose base is 0 while no folded row exists", () => {
    const rows = mergeActualAdjustments(
      [],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 0 })],
    );

    expect(rows[0]?.totalHours).toBe(0);
    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("skips the check when no base was recorded", () => {
    // null means "unknown", never "unchanged". Flagging unknown would light the warning on
    // every hand-inserted row forever, which teaches the operator to ignore it.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 31000)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: null })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("absorbs float noise from a re-fold of unchanged detail", () => {
    // The two sides reach the same figure by different routes - one stored REAL read back,
    // one re-summed from per-person quarter-hours - so bit-exact equality would raise a
    // false alarm every time an unchanged month is re-folded.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 6870.0000000001)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("still flags a drift smaller than the source data's own precision", () => {
    // The tolerance must not grow into a place real edits can hide: 0.1 is the finest
    // figure the source sheets carry, and it is reported.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 6870.1)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
  });

  it("flags a corrupt base rather than reporting no drift", () => {
    // NaN makes every comparison false, so a `>` test would answer "unchanged". The base
    // enters no total, so flagging is the safe direction - it cannot poison a roll-up, and
    // a garbage snapshot is itself a reason to look at the row.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 6870)],
      [slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: Number.NaN })],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
  });

  it("keeps the flag once raised, even if a later slip matches the current base", () => {
    // A fresh slip does not vindicate the stale one: both sets of hours are still summed
    // into adjustmentHours, so the total stays suspect.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 31000)],
      [
        slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 }),
        slip("adj-2", "sec-a", 5, 50, { foldHoursAtEntry: 31000 }),
      ],
    );

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(true);
    expect(rows[0]?.adjustmentHours).toBe(24050);
  });

  it("ignores a revoked slip's stale base", () => {
    // Revoking is how a stale slip gets resolved. If the revoked one kept flagging, the
    // warning could never be cleared and would sit on the screen permanently.
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 31000)],
      [
        slip("adj-1", "sec-a", 5, 24000, {
          foldHoursAtEntry: 6870,
          revokedAt: new Date("2026-09-02T00:00:00Z"),
          revokedBy: "admin",
        }),
      ],
    );

    expect(rows[0]?.adjustmentHours).toBe(0);
    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("leaves the flag false on a row with no slips at all", () => {
    const rows = mergeActualAdjustments([actual("sec-a", 5, 100)], []);

    expect(rows[0]?.foldChangedSinceAdjustment).toBe(false);
  });

  it("does not leak a flag from one section-month to another", () => {
    const rows = mergeActualAdjustments(
      [actual("sec-a", 5, 31000), actual("sec-b", 5, 200)],
      [
        slip("adj-1", "sec-a", 5, 24000, { foldHoursAtEntry: 6870 }),
        slip("adj-2", "sec-b", 5, 30, { foldHoursAtEntry: 200 }),
      ],
    );

    expect(rows.find((row) => row.sectionId === "sec-a")?.foldChangedSinceAdjustment).toBe(
      true,
    );
    expect(rows.find((row) => row.sectionId === "sec-b")?.foldChangedSinceAdjustment).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------------
// 3. adjustedMonths - the footnote
// --------------------------------------------------------------------------------

describe("adjustedMonths", () => {
  it("returns the distinct months carrying un-revoked slips, ascending", () => {
    const months = adjustedMonths([
      slip("adj-1", "sec-a", 5, 10),
      slip("adj-2", "sec-b", 5, 10),
      slip("adj-3", "sec-a", 2, 10),
    ]);

    expect(months).toEqual([2, 5]);
  });

  it("excludes a month whose only slip was revoked", () => {
    const months = adjustedMonths([
      slip("adj-1", "sec-a", 5, 10),
      slip("adj-2", "sec-a", 9, 10, { revokedAt: new Date("2026-09-02T00:00:00Z") }),
    ]);

    expect(months).toEqual([5]);
  });

  it("returns nothing for an empty list", () => {
    expect(adjustedMonths([])).toEqual([]);
  });
});

// --------------------------------------------------------------------------------
// 4. The write boundary
// --------------------------------------------------------------------------------

describe("createActualAdjustment", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.createMany.mockReset();
    mocks.updateMany.mockReset();
    mocks.findMany.mockReset();
    mocks.actualFindMany.mockReset();
    mocks.create.mockResolvedValue({ id: "adj-new" });
    mocks.createMany.mockResolvedValue({ count: 0 });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.actualFindMany.mockResolvedValue([]);
  });

  const valid = {
    sectionId: "sec-a",
    fiscalYearId: FY,
    month: 5,
    hours: 320,
    reason: "8月1-25日按课合计补录",
  };

  it("writes the slip and stamps the fixed actor", async () => {
    const id = await createActualAdjustment(valid);

    expect(id).toBe("adj-new");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[0]?.data).toMatchObject({
      sectionId: "sec-a",
      fiscalYearId: FY,
      month: 5,
      hours: 320,
      changedBy: "admin",
    });
  });

  it("stores the reason trimmed", async () => {
    await createActualAdjustment({ ...valid, reason: "  差异调整  " });

    expect(mocks.create.mock.calls[0]?.[0]?.data?.reason).toBe("差异调整");
  });

  it.each([0, 13, -1, 1.5])("rejects month %o without writing", async (month) => {
    await expect(createActualAdjustment({ ...valid, month })).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a zero adjustment", async () => {
    // Changes no total, yet marks the month as adjusted on screen.
    await expect(createActualAdjustment({ ...valid, hours: 0 })).rejects.toThrow(/0/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    "rejects the non-finite hours %o",
    async (hours) => {
      await expect(createActualAdjustment({ ...valid, hours })).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", "\t\n"])("rejects the blank reason %o", async (reason) => {
    // With no approval gate, the reason is the only explanation the discrepancy ever gets.
    await expect(createActualAdjustment({ ...valid, reason })).rejects.toThrow(/理由/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts a negative adjustment", async () => {
    await createActualAdjustment({ ...valid, hours: -12.5 });

    expect(mocks.create.mock.calls[0]?.[0]?.data?.hours).toBe(-12.5);
  });

  it("records the section-month's current folded hours as the slip's base", async () => {
    mocks.actualFindMany.mockResolvedValue([
      { sectionId: "sec-a", fiscalYearId: FY, month: 5, totalHours: 6870 },
    ]);

    await createActualAdjustment(valid);

    expect(mocks.create.mock.calls[0]?.[0]?.data?.foldHoursAtEntry).toBe(6870);
  });

  it("records 0, not null, when the section-month has no folded row", async () => {
    // Null would exempt exactly the slips most at risk - those entered before any detail
    // arrived - from the drift check. 0 is true, and a later fold moves it.
    mocks.actualFindMany.mockResolvedValue([]);

    await createActualAdjustment(valid);

    expect(mocks.create.mock.calls[0]?.[0]?.data?.foldHoursAtEntry).toBe(0);
  });

  it("does not borrow another section-month's folded hours", async () => {
    // The base read filters by the cross product of sections and months, so a query can
    // return rows the slip does not belong to. Matching is by exact key.
    mocks.actualFindMany.mockResolvedValue([
      { sectionId: "sec-b", fiscalYearId: FY, month: 5, totalHours: 9999 },
      { sectionId: "sec-a", fiscalYearId: FY, month: 4, totalHours: 8888 },
    ]);

    await createActualAdjustment(valid);

    expect(mocks.create.mock.calls[0]?.[0]?.data?.foldHoursAtEntry).toBe(0);
  });
});

describe("createActualAdjustmentsBulk", () => {
  beforeEach(() => {
    mocks.createMany.mockReset();
    mocks.actualFindMany.mockReset();
    mocks.createMany.mockResolvedValue({ count: 2 });
    mocks.actualFindMany.mockResolvedValue([]);
  });

  const row = (sectionId: string, hours: number) => ({
    sectionId,
    fiscalYearId: FY,
    month: 5,
    hours,
    reason: "8月1-25日按课合计补录",
  });

  it("writes every row in one call", async () => {
    const written = await createActualAdjustmentsBulk([row("sec-a", 100), row("sec-b", 200)]);

    expect(written).toBe(2);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.createMany.mock.calls[0]?.[0]?.data).toHaveLength(2);
  });

  it("writes nothing when any row is invalid", async () => {
    // A half-imported back-fill is the worst outcome available: totals end up wrong by an
    // amount nobody can derive without re-reading the source sheet.
    await expect(
      createActualAdjustmentsBulk([row("sec-a", 100), { ...row("sec-b", 200), hours: 0 }]),
    ).rejects.toThrow();

    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it("validates before opening the write, regardless of which row is bad", async () => {
    await expect(
      createActualAdjustmentsBulk([{ ...row("sec-a", 100), reason: " " }, row("sec-b", 200)]),
    ).rejects.toThrow(/理由/);

    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it("writes nothing and reports zero for an empty list", async () => {
    expect(await createActualAdjustmentsBulk([])).toBe(0);
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it("gives each row its own section's folded base", async () => {
    mocks.actualFindMany.mockResolvedValue([
      { sectionId: "sec-a", fiscalYearId: FY, month: 5, totalHours: 300 },
      { sectionId: "sec-b", fiscalYearId: FY, month: 5, totalHours: 0 },
    ]);

    await createActualAdjustmentsBulk([row("sec-a", 100), row("sec-b", 200), row("sec-c", 300)]);

    const written = mocks.createMany.mock.calls[0]?.[0]?.data as Array<{
      sectionId: string;
      foldHoursAtEntry: number;
    }>;
    expect(written.map((entry) => [entry.sectionId, entry.foldHoursAtEntry])).toEqual([
      ["sec-a", 300],
      ["sec-b", 0],
      ["sec-c", 0],
    ]);
  });

  it("reads the bases with a bounded number of bind parameters", async () => {
    // Exact (section, year, month) tuples would be ~3 parameters each; a 24-section x
    // 12-month paste lands near SQLite's 999 limit and fails on a ceiling nobody would
    // connect to this function. The cross product keeps it to sections + months + years.
    const wide = Array.from({ length: 24 }, (_, index) =>
      Array.from({ length: 12 }, (_, monthIndex) => ({
        sectionId: `sec-${index}`,
        fiscalYearId: FY,
        month: monthIndex + 1,
        hours: 10,
        reason: "补录",
      })),
    ).flat();

    await createActualAdjustmentsBulk(wide);

    const where = mocks.actualFindMany.mock.calls[0]?.[0]?.where;
    expect(where?.sectionId?.in).toHaveLength(24);
    expect(where?.month?.in).toHaveLength(12);
    expect(where?.fiscalYearId?.in).toEqual([FY]);
  });
});

describe("revokeActualAdjustment", () => {
  beforeEach(() => {
    mocks.updateMany.mockReset();
  });

  it("scopes the write to un-revoked rows, so two clicks cannot both win", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    expect(await revokeActualAdjustment("adj-1")).toBe(true);

    const args = mocks.updateMany.mock.calls[0]?.[0];
    expect(args?.where).toMatchObject({ id: "adj-1", revokedAt: null });
    expect(args?.data?.revokedBy).toBe("admin");
    expect(args?.data?.revokedAt).toBeInstanceOf(Date);
  });

  it("reports false when the slip was already revoked or does not exist", async () => {
    // Not an exception: this is the expected outcome of a double click. The caller has to
    // surface it, because a swallowed false reads on screen as a revoke that happened.
    mocks.updateMany.mockResolvedValue({ count: 0 });

    expect(await revokeActualAdjustment("adj-1")).toBe(false);
  });
});

describe("findActiveAdjustmentsByFiscalYear", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.findMany.mockResolvedValue([]);
  });

  it("excludes revoked slips in SQL, not just in the caller", async () => {
    await findActiveAdjustmentsByFiscalYear(FY);

    expect(mocks.findMany.mock.calls[0]?.[0]?.where).toEqual({
      fiscalYearId: FY,
      revokedAt: null,
    });
  });
});
