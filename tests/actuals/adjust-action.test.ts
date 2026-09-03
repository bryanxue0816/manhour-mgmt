// Behaviour of the two adjustment Server Actions, with a valid session present.
//
// tests/security/action-gates.test.ts covers the refusal path for these same two actions.
// This file is about what happens AFTER the gate admits, and every case in it exists
// because a plausible implementation gets it wrong in a way the operator cannot see:
//
//   * The subtraction base is 当前实绩 (fold + un-revoked slips), NOT the fold. Getting
//     this wrong on a section-month that already carries a slip produces a delta with the
//     WRONG SIGN, and the resulting row looks entirely ordinary in the audit trail.
//   * A blank cell is not a zero. Treating blank as 0 would file a slip against all 24
//     課 on every submission, zeroing every section the operator did not tally.
//   * A stale base refuses the WHOLE batch. Writing the rows that still agree would leave
//     a half-reconciled month whose remaining difference cannot be located afterwards.
//   * "Nothing differed" is a success. Reporting it as a failure teaches the operator that
//     the screen is broken when it is in fact telling them the figures already match.
//
// The repositories are mocked, so this file asserts what the action DECIDES to write. That
// the write itself lands correctly is tests/db/actual-adjustment.test.ts's job.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantAdminSession } from "../helpers/admin-session";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  loadOrgSnapshot: vi.fn(),
  findFiscalYearByYear: vi.fn(),
  findEffectiveActualsByFiscalYear: vi.fn(),
  createActualAdjustmentsBulk: vi.fn(),
  revokeActualAdjustment: vi.fn(),
  cookieGet: vi.fn<(name: string) => { name: string; value: string } | undefined>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/db/org.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/org.repo")>()),
  loadOrgSnapshot: mocks.loadOrgSnapshot,
}));

vi.mock("@/lib/db/fiscal-year.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/fiscal-year.repo")>()),
  findFiscalYearByYear: mocks.findFiscalYearByYear,
}));

vi.mock("@/lib/db/actual-effective.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/actual-effective.repo")>()),
  findEffectiveActualsByFiscalYear: mocks.findEffectiveActualsByFiscalYear,
}));

vi.mock("@/lib/db/actual-adjustment.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/actual-adjustment.repo")>()),
  createActualAdjustmentsBulk: mocks.createActualAdjustmentsBulk,
  revokeActualAdjustment: mocks.revokeActualAdjustment,
}));

import {
  revokeAdjustment,
  submitActualAdjustments,
  type SubmitAdjustmentsInput,
} from "@/app/actuals/adjust/actions";
import { resolveAdjustTarget } from "@/lib/attendance/adjust-window";
import { ACTUAL_SOURCE_FOLD, ACTUAL_SOURCE_MANUAL, type ActualSource } from "@/lib/db/actual-source";
import { DENIED_MESSAGE } from "@/lib/auth";
import type { ActualEffectiveRow } from "@/lib/db/types";

/**
 * The month the action will accept, derived the way the action derives it.
 *
 * Hard-coding a month would make the whole file start failing on the 1st of some future
 * month for a reason unrelated to any of these behaviours.
 */
const TARGET = resolveAdjustTarget(new Date());

const FY_ID = "fy-under-test";
const ALPHA = "sec-alpha";
const BRAVO = "sec-bravo";
const CHARLIE = "sec-charlie";

/** Three 課 in one 部, enough to tell "wrote only the differing row" from "wrote all". */
function orgSnapshot() {
  return {
    departments: [
      {
        id: "dep-1",
        name: "製造部",
        code: "MFG",
        sortOrder: 1,
        managerName: null,
        managerEmail: null,
      },
    ],
    sections: [ALPHA, BRAVO, CHARLIE].map((id, index) => ({
      id,
      departmentId: "dep-1",
      name: `第${String(index + 1)}課`,
      sortOrder: index + 1,
      managerName: null,
      managerEmail: null,
    })),
  };
}

/**
 * One merged (課, 月) row, as findEffectiveActualsByFiscalYear would return it.
 *
 * `adjustmentHours` is the sum of un-revoked slips already on the section-month, and
 * `effectiveHours` is what the sheet shows - the two are set independently here precisely
 * so a test can prove the action subtracts from the latter.
 */
function effectiveRow(
  sectionId: string,
  options: {
    totalHours: number;
    adjustmentHours?: number;
    source?: ActualSource;
    foldChangedSinceAdjustment?: boolean;
    month?: number;
  },
): ActualEffectiveRow {
  const adjustmentHours = options.adjustmentHours ?? 0;
  return {
    sectionId,
    fiscalYearId: FY_ID,
    month: options.month ?? TARGET.month,
    personnelHours: options.totalHours,
    overtimeHours: 0,
    totalHours: options.totalHours,
    source: options.source ?? ACTUAL_SOURCE_FOLD,
    adjustmentHours,
    effectiveHours: options.totalHours + adjustmentHours,
    foldChangedSinceAdjustment: options.foldChangedSinceAdjustment ?? false,
  };
}

/** Points findEffectiveActualsByFiscalYear at a given set of merged rows. */
function withActuals(rows: readonly ActualEffectiveRow[]): void {
  mocks.findEffectiveActualsByFiscalYear.mockResolvedValue({
    rows,
    adjustedMonths: [...new Set(rows.filter((row) => row.adjustmentHours !== 0).map((r) => r.month))],
  });
}

/** A well-formed payload for the accepted month, overridable per test. */
function payload(overrides: Partial<SubmitAdjustmentsInput> = {}): SubmitAdjustmentsInput {
  return {
    fiscalYear: TARGET.fiscalYear,
    month: TARGET.month,
    reason: "与人工统计核对后修正",
    entries: {},
    bases: {},
    riskAcknowledged: false,
    ...overrides,
  };
}

/** The rows handed to createActualAdjustmentsBulk on the single call it received. */
function writtenRows(): readonly {
  sectionId: string;
  fiscalYearId: string;
  month: number;
  hours: number;
  reason: string;
}[] {
  expect(mocks.createActualAdjustmentsBulk).toHaveBeenCalledTimes(1);
  return mocks.createActualAdjustmentsBulk.mock.calls[0]?.[0] as never;
}

beforeEach(() => {
  mocks.cookieGet.mockReset();
  grantAdminSession(mocks.cookieGet);

  mocks.revalidatePath.mockReset();
  mocks.loadOrgSnapshot.mockReset();
  mocks.findFiscalYearByYear.mockReset();
  mocks.findEffectiveActualsByFiscalYear.mockReset();
  mocks.createActualAdjustmentsBulk.mockReset();
  mocks.revokeActualAdjustment.mockReset();

  mocks.loadOrgSnapshot.mockResolvedValue(orgSnapshot());
  mocks.findFiscalYearByYear.mockResolvedValue({
    id: FY_ID,
    name: `FY${String(TARGET.fiscalYear)}`,
    year: TARGET.fiscalYear,
    startDate: new Date(Date.UTC(TARGET.fiscalYear, 3, 1)),
    endDate: new Date(Date.UTC(TARGET.fiscalYear + 1, 2, 31)),
    isCurrent: true,
  });
  withActuals([]);
  // Returns the row count, as the repository does - `written` is the repository's answer,
  // not the action's own tally, so a fixed stub would hide a mismatch between the two.
  mocks.createActualAdjustmentsBulk.mockImplementation((rows: readonly unknown[]) =>
    Promise.resolve(rows.length),
  );
  mocks.revokeActualAdjustment.mockResolvedValue(true);

  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("submitActualAdjustments - what gets written", () => {
  it("writes only the 課 whose figure differs, leaving blanks and matches alone", async () => {
    withActuals([
      effectiveRow(ALPHA, { totalHours: 1000 }),
      effectiveRow(BRAVO, { totalHours: 2000 }),
      effectiveRow(CHARLIE, { totalHours: 3000 }),
    ]);

    const result = await submitActualAdjustments(
      payload({
        // ALPHA differs, BRAVO agrees exactly, CHARLIE was not tallied at all.
        entries: { [ALPHA]: "1050", [BRAVO]: "2000", [CHARLIE]: "" },
        bases: { [ALPHA]: 1000 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toBe(1);
    expect(result.unchangedCount).toBe(1);
    expect(result.blankCount).toBe(1);

    const rows = writtenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectionId).toBe(ALPHA);
    expect(rows[0]?.hours).toBe(50);
    expect(rows[0]?.month).toBe(TARGET.month);
    expect(rows[0]?.fiscalYearId).toBe(FY_ID);
  });

  it("subtracts from 当前实绩, not from the fold, when a slip already exists", async () => {
    // The worked example from the requirement: a fold of 865 carrying an earlier +100 slip
    // shows 965 on the sheet. A hand tally of 920 is therefore 45 hours SHORT of what the
    // system reports - not 55 over the raw fold. Subtracting from totalHours would file
    // +55, moving the section further from the hand tally it was meant to reconcile to.
    withActuals([effectiveRow(ALPHA, { totalHours: 865, adjustmentHours: 100 })]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "920" }, bases: { [ALPHA]: 965 } }),
    );

    expect(result.ok).toBe(true);
    expect(writtenRows()[0]?.hours).toBe(-45);
  });

  it("records the arithmetic in the reason, since foldHoursAtEntry stores the fold", async () => {
    // A stored row of hours=-45 / foldHoursAtEntry=865 gives an auditor no way to see that
    // 965 was the figure on screen. The suffix is what makes the row self-explaining.
    withActuals([effectiveRow(ALPHA, { totalHours: 865, adjustmentHours: 100 })]);

    await submitActualAdjustments(
      payload({
        reason: "与人工统计核对后修正",
        entries: { [ALPHA]: "920" },
        bases: { [ALPHA]: 965 },
      }),
    );

    expect(writtenRows()[0]?.reason).toBe(
      "与人工统计核对后修正（人工统计 920 H − 当前实绩 965 H）",
    );
  });

  it("keeps every stored reason within the repository's limit", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    await submitActualAdjustments(
      payload({
        reason: "补".repeat(120),
        entries: { [ALPHA]: "1050" },
        bases: { [ALPHA]: 1000 },
      }),
    );

    // 200 is REASON_MAX_LENGTH; the repository has no length guard of its own, so an
    // over-long reason would be an unbounded write rather than a caught error.
    expect(writtenRows()[0]?.reason.length).toBeLessThanOrEqual(200);
  });

  it("treats a tallied 0 as a real figure and a blank as no opinion", async () => {
    withActuals([
      effectiveRow(ALPHA, { totalHours: 500 }),
      effectiveRow(BRAVO, { totalHours: 500 }),
    ]);

    const result = await submitActualAdjustments(
      payload({
        entries: { [ALPHA]: "0", [BRAVO]: "" },
        bases: { [ALPHA]: 500 },
        // Zeroing a 500-hour section is high-risk by design; the point here is only that
        // the two cells are read differently.
        riskAcknowledged: true,
      }),
    );

    expect(result.ok).toBe(true);
    const rows = writtenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectionId).toBe(ALPHA);
    expect(rows[0]?.hours).toBe(-500);
  });

  it("reports 'nothing differed' as a success and writes nothing", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1000" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toBe(0);
    expect(result.unchangedCount).toBe(1);
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
    // Nothing changed, so nothing needs re-rendering.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("accepts a month that is on a hand-entered baseline", async () => {
    // D-198 months carry no fold to re-run, and this screen is the only way to correct
    // them. Refusing them would leave a hand-keyed month permanently uncorrectable.
    withActuals([
      effectiveRow(ALPHA, { totalHours: 6870, source: ACTUAL_SOURCE_MANUAL }),
    ]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "6900" }, bases: { [ALPHA]: 6870 } }),
    );

    expect(result.ok).toBe(true);
    expect(writtenRows()[0]?.hours).toBe(30);
  });

  it("refreshes both screens after a write", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/actuals");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/actuals/adjust");
  });

  it("warns without refusing when the difference is not a multiple of 0.5", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1000.3" }, bases: { [ALPHA]: 1000 } }),
    );

    // Rejecting would be wrong: tests/db/actual-adjustment.test.ts stores -12.5 and no
    // 0.5 rule exists anywhere in the codebase. The odd figure is a smell, not an error.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("第1課");
    expect(mocks.createActualAdjustmentsBulk).toHaveBeenCalledTimes(1);
  });
});

describe("submitActualAdjustments - what gets refused", () => {
  it("refuses an anonymous caller before reading anything", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(DENIED_MESSAGE);
    // The gate is first, so an unauthorised caller cannot even probe the org chart.
    expect(mocks.loadOrgSnapshot).not.toHaveBeenCalled();
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses a blank reason", async () => {
    const result = await submitActualAdjustments(
      payload({ reason: "   ", entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("调整原因");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses an over-long reason", async () => {
    const result = await submitActualAdjustments(
      payload({ reason: "长".repeat(121), entries: { [ALPHA]: "1" }, bases: { [ALPHA]: 0 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("120");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses a month outside the adjustment window", async () => {
    // The month AFTER the target is the current month, and corrections are filed 只在次月.
    const result = await submitActualAdjustments(
      payload({
        month: TARGET.month === 12 ? 13 : TARGET.month + 1,
        entries: { [ALPHA]: "1050" },
        bases: { [ALPHA]: 1000 },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("可调整范围");
    // Refused before the fiscal year is even resolved - the window is about the clock,
    // and the clock is the server's.
    expect(mocks.findFiscalYearByYear).not.toHaveBeenCalled();
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses a fiscal year that does not exist", async () => {
    mocks.findFiscalYearByYear.mockResolvedValue(null);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("未找到财年");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("returns a per-課 error for an unreadable entry and writes nothing at all", async () => {
    withActuals([
      effectiveRow(ALPHA, { totalHours: 1000 }),
      effectiveRow(BRAVO, { totalHours: 2000 }),
    ]);

    const result = await submitActualAdjustments(
      payload({
        // BRAVO is perfectly good; the batch still does not write, because a month
        // reconciled except for one row is a month nobody can reconcile later.
        entries: { [ALPHA]: "-45", [BRAVO]: "2050" },
        bases: { [ALPHA]: 1000, [BRAVO]: 2000 },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors)).toEqual([ALPHA]);
    expect(result.fieldErrors[ALPHA]).toContain("正数");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses a submission naming a 課 that is not on the sheet", async () => {
    const result = await submitActualAdjustments(
      payload({ entries: { "sec-ghost": "1050" }, bases: { "sec-ghost": 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("未知课别");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses when no figure was entered anywhere", async () => {
    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "", [BRAVO]: "  " } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("请先填写");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses the whole batch when the base moved under the form", async () => {
    // The fold re-runs at 09:05 and 15:05, and another operator may file a slip meanwhile.
    // Either moves 当前实绩 while the sheet is still on screen.
    withActuals([
      effectiveRow(ALPHA, { totalHours: 1040 }),
      effectiveRow(BRAVO, { totalHours: 2000 }),
    ]);

    const result = await submitActualAdjustments(
      payload({
        entries: { [ALPHA]: "1050", [BRAVO]: "2050" },
        bases: { [ALPHA]: 1000, [BRAVO]: 2000 },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("已过期");
    expect(result.staleRows).toHaveLength(1);
    expect(result.staleRows[0]).toMatchObject({ shown: 1000, current: 1040 });
    // BRAVO agreed and is still not written - see the message above.
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("refuses a write row whose base was not posted", async () => {
    // Omitting the field is the cheapest way to defeat the drift check, so a missing base
    // is a refusal rather than a skipped comparison.
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("缺少基准值");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("accepts a fractional base without reporting phantom drift", async () => {
    // The hidden field must carry the RAW number: formatHoursValue caps at one decimal, so
    // a base of 965.25 posted as its formatted "965.3" would refuse a batch nobody touched.
    withActuals([effectiveRow(ALPHA, { totalHours: 965.25 })]);

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1000" }, bases: { [ALPHA]: 965.25 } }),
    );

    expect(result.ok).toBe(true);
    expect(writtenRows()[0]?.hours).toBe(34.75);
  });

  it("asks for one batch-level confirmation before a large correction", async () => {
    withActuals([
      effectiveRow(ALPHA, { totalHours: 1000 }),
      effectiveRow(BRAVO, { totalHours: 2000 }),
    ]);

    const result = await submitActualAdjustments(
      payload({
        // ALPHA halves; BRAVO moves by a routine amount.
        entries: { [ALPHA]: "300", [BRAVO]: "2050" },
        bases: { [ALPHA]: 1000, [BRAVO]: 2000 },
        riskAcknowledged: false,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.needsConfirmation).toHaveLength(1);
    expect(result.needsConfirmation[0]).toMatchObject({
      sectionName: "第1課",
      baseHours: 1000,
      manualHours: 300,
      delta: -700,
    });
    expect(result.needsConfirmation[0]?.risk).not.toBe("");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("writes the large correction once it has been acknowledged", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);

    const result = await submitActualAdjustments(
      payload({
        entries: { [ALPHA]: "300" },
        bases: { [ALPHA]: 1000 },
        riskAcknowledged: true,
      }),
    );

    expect(result.ok).toBe(true);
    expect(writtenRows()[0]?.hours).toBe(-700);
  });

  it("does not call every row high-risk when the month has no folded hours", async () => {
    // A month whose fold never landed (D-207) reads 0 for all 24 課. Flagging each one
    // would put 24 confirmations in front of the operator, which is worth the same as none.
    withActuals([]);

    const result = await submitActualAdjustments(
      payload({
        entries: { [ALPHA]: "1000", [BRAVO]: "2000", [CHARLIE]: "3000" },
        bases: { [ALPHA]: 0, [BRAVO]: 0, [CHARLIE]: 0 },
        riskAcknowledged: false,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toBe(3);
    expect(writtenRows()).toHaveLength(3);
  });

  it("reports a failed write as 数据未写入 rather than throwing", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);
    mocks.createActualAdjustmentsBulk.mockRejectedValue(new Error("SQLITE_BUSY"));

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("数据未写入");
    // A thrown action reaches the browser as an opaque digest in production, which is
    // exactly the information this screen exists to provide.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a failed read without claiming a write was attempted", async () => {
    mocks.findEffectiveActualsByFiscalYear.mockRejectedValue(new Error("no such table"));

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("读取当前实绩失败");
    expect(mocks.createActualAdjustmentsBulk).not.toHaveBeenCalled();
  });

  it("survives revalidatePath failing after the rows are committed", async () => {
    withActuals([effectiveRow(ALPHA, { totalHours: 1000 })]);
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("revalidate outside a request scope");
    });

    const result = await submitActualAdjustments(
      payload({ entries: { [ALPHA]: "1050" }, bases: { [ALPHA]: 1000 } }),
    );

    // Reporting this as a failure would send the operator to re-file a slip that is
    // already stored - and this table has no unique key to stop the duplicate.
    expect(result.ok).toBe(true);
    expect(mocks.createActualAdjustmentsBulk).toHaveBeenCalledTimes(1);
  });
});

describe("revokeAdjustment", () => {
  it("revokes a slip and refreshes both screens", async () => {
    const result = await revokeAdjustment({ id: "adj-1" });

    expect(result.ok).toBe(true);
    expect(mocks.revokeActualAdjustment).toHaveBeenCalledWith("adj-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/actuals");
  });

  it("surfaces a no-op revoke instead of reporting success", async () => {
    // The repository returns false for "already revoked, or never existed". Swallowing it
    // shows a successful revoke on screen while the hours stay in every total.
    mocks.revokeActualAdjustment.mockResolvedValue(false);

    const result = await revokeAdjustment({ id: "adj-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("已被撤销");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller without touching the row", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    const result = await revokeAdjustment({ id: "adj-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(DENIED_MESSAGE);
    expect(mocks.revokeActualAdjustment).not.toHaveBeenCalled();
  });

  it("refuses a blank id", async () => {
    const result = await revokeAdjustment({ id: "  " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("缺少调整单标识");
    expect(mocks.revokeActualAdjustment).not.toHaveBeenCalled();
  });

  it("reports a failed revoke as 数据未变更", async () => {
    mocks.revokeActualAdjustment.mockRejectedValue(new Error("SQLITE_BUSY"));

    const result = await revokeAdjustment({ id: "adj-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("数据未变更");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
