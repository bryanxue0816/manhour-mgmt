// D-174 acceptance: the required modification reason, at the boundary that matters.
//
// The dialog in PlanGridEditor and the `required` input in PlanImportForm are prompts,
// not defences - a Server Action is a public HTTP endpoint, so anything reachable by
// fetch() must refuse a blank reason on its own. That refusal is what this suite pins.
//
// Both action modules import repositories that build a better-sqlite3 PrismaClient at
// module load, so the repositories are mocked here: the point of these tests is the
// boundary check, and a unit test must not need a database to prove it.
//
// A valid admin session is granted in beforeEach because both actions call requireAdmin()
// first (2026-08-17). Without it every case below would return 需要管理员权限 and pass for
// the wrong reason - the reason checks would never run. tests/security/action-gates.test.ts
// is where the ABSENT session is asserted.
//
// The load-bearing assertion in every rejection case is NOT the message - it is that
// the write function was never called. A boundary that returns the right text and
// writes anyway would pass a message-only test while failing the requirement.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantAdminSession } from "../helpers/admin-session";

const mocks = vi.hoisted(() => ({
  upsertPlanWithAudit: vi.fn(),
  upsertPlansBulkWithAudit: vi.fn(),
  countPlansByFiscalYear: vi.fn(),
  findFiscalYearById: vi.fn(),
  loadOrgSnapshot: vi.fn(),
  revalidatePath: vi.fn(),
  cookieGet: vi.fn<(name: string) => { name: string; value: string } | undefined>(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet }) }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/db/plan.repo", () => ({
  upsertPlanWithAudit: mocks.upsertPlanWithAudit,
  upsertPlansBulkWithAudit: mocks.upsertPlansBulkWithAudit,
  countPlansByFiscalYear: mocks.countPlansByFiscalYear,
}));

vi.mock("@/lib/db/fiscal-year.repo", () => ({
  findFiscalYearById: mocks.findFiscalYearById,
}));

vi.mock("@/lib/db/org.repo", () => ({
  loadOrgSnapshot: mocks.loadOrgSnapshot,
}));

import { savePlanCell, type SavePlanCellInput } from "@/app/plans/actions";
import { commitPlanImport } from "@/app/plans/import/actions";

/** A payload that passes every check EXCEPT the one under test. */
function validInput(overrides: Partial<SavePlanCellInput> = {}): SavePlanCellInput {
  return {
    sectionId: "sec-1",
    fiscalYearId: "fy-2026",
    month: 1,
    plannedRaw: "1045",
    challengeRaw: "1100",
    reason: "年中预算调整,追加 A 线增产工时。",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.cookieGet.mockReset();
  grantAdminSession(mocks.cookieGet);

  mocks.upsertPlanWithAudit.mockResolvedValue({
    planId: "plan-1",
    created: false,
    loggedChanges: 1,
  });
});

describe("savePlanCell - reason is required (D-174)", () => {
  it("refuses an empty reason without writing", async () => {
    const result = await savePlanCell(validInput({ reason: "" }));

    expect(result).toEqual({ ok: false, message: "请填写修改原因后再保存。", fieldErrors: {} });
    expect(mocks.upsertPlanWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only reason without writing", async () => {
    // Whitespace is the interesting case: it satisfies a browser `required` attribute
    // and a naive `!== ""` check, and would store a row whose reason reads as blank.
    const result = await savePlanCell(validInput({ reason: "   \n\t " }));

    expect(result.ok).toBe(false);
    expect(mocks.upsertPlanWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a non-string reason without writing", async () => {
    // Reachable by fetch() with a hand-built body; the types do not survive the wire.
    const result = await savePlanCell(
      validInput({ reason: 42 as unknown as string }),
    );

    expect(result).toMatchObject({ ok: false, message: "修改原因格式不合法。" });
    expect(mocks.upsertPlanWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a reason longer than the column guard without writing", async () => {
    const result = await savePlanCell(validInput({ reason: "调".repeat(201) }));

    expect(result).toMatchObject({ ok: false, message: "修改原因最长 200 字。" });
    expect(mocks.upsertPlanWithAudit).not.toHaveBeenCalled();
  });

  it("writes the reason trimmed when one is supplied", async () => {
    const result = await savePlanCell(validInput({ reason: "  年中预算调整  " }));

    expect(result.ok).toBe(true);
    expect(mocks.upsertPlanWithAudit).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPlanWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "年中预算调整", changedBy: "admin" }),
    );
  });
});

describe("commitPlanImport - reason is required (D-174)", () => {
  /** Only the fields the reason check runs before; no file, deliberately. */
  function commitForm(reason: string | null): FormData {
    const formData = new FormData();
    formData.set("fiscalYearId", "fy-2026");
    if (reason !== null) {
      formData.set("reason", reason);
    }
    return formData;
  }

  it("refuses an empty reason before touching the upload or the database", async () => {
    // No file is attached, yet the reason message is what comes back - that ordering is
    // the assertion: an operator who forgot the note is told so, not handed a file error.
    const result = await commitPlanImport(commitForm(""));

    expect(result).toMatchObject({ ok: false, message: "请填写导入说明后再导入。" });
    expect(mocks.findFiscalYearById).not.toHaveBeenCalled();
    expect(mocks.upsertPlansBulkWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only reason", async () => {
    const result = await commitPlanImport(commitForm("  \t "));

    expect(result).toMatchObject({ ok: false, message: "请填写导入说明后再导入。" });
    expect(mocks.upsertPlansBulkWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a missing reason field", async () => {
    // The old form omitted the key entirely when blank. A stale browser tab still can,
    // so an absent key must fail the same way an empty one does.
    const result = await commitPlanImport(commitForm(null));

    expect(result).toMatchObject({ ok: false, message: "请填写导入说明后再导入。" });
    expect(mocks.upsertPlansBulkWithAudit).not.toHaveBeenCalled();
  });

  it("refuses a reason longer than the column guard", async () => {
    const result = await commitPlanImport(commitForm("版".repeat(201)));

    expect(result).toMatchObject({ ok: false });
    expect(mocks.upsertPlansBulkWithAudit).not.toHaveBeenCalled();
  });
});
