// Every Server Action must refuse an anonymous caller BEFORE it writes anything.
//
// This is the regression test for a bypass that was measured, not theorised. On
// 2026-08-17 all five `/admin` Server Actions were invoked successfully by POSTing to
// `/` - the public dashboard - with a `Next-Action` header carrying the action id. Each
// one returned its own validation error, proving it had executed, with no navigation to
// /admin at all. A Server Action's id resolves against a global manifest; its execution
// is not bound to the route it was declared in.
//
// So there is exactly one place a check can work: inside the action body. This file
// asserts all twelve of them are gated, and asserts it the same way the original attack
// measured the hole - by the message that comes back.
//
// WHY THE MESSAGE IS THE ASSERTION HERE, unlike everywhere else in this suite:
// DENIED_MESSAGE is the only response an ungated action CANNOT produce. Remove a gate
// and the action falls through to its own shape validation, which answers
// "缺少课标识" or "请先选择所属部门" - exactly what the attack saw. Comparing against
// the repository not being called is not enough on its own, because several of these
// actions reject a malformed payload without writing either.
//
// The session is genuinely absent - `next/headers` returns no cookie and the real
// `requireAdmin()` runs. Mocking `requireAdmin` would test that the mock denies.
//
// `@/lib/prisma` is mocked to a bare object so importing the repositories never builds a
// better-sqlite3 client; the repository writes are mocked so a missing gate shows up as
// a called spy rather than a connection error that gets swallowed into ok:false.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  // Every function these five action modules can use to touch the database.
  createJobTitleRule: vi.fn(),
  upsertJobTitleRule: vi.fn(),
  renameSectionWithAlias: vi.fn(),
  updateDepartment: vi.fn(),
  updateSection: vi.fn(),
  upsertSection: vi.fn(),
  loadOrgSnapshot: vi.fn(),
  upsertPlanWithAudit: vi.fn(),
  countPlansByFiscalYear: vi.fn(),
  upsertPlansBulkWithAudit: vi.fn(),
  findFiscalYearById: vi.fn(),
  findFiscalYearByYear: vi.fn(),
  hasSuccessfulImport: vi.fn(),
  ingestAttendanceSource: vi.fn(),
  inspectAttendanceSource: vi.fn(),
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

vi.mock("@/lib/db/job-title-rule.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/job-title-rule.repo")>()),
  createJobTitleRule: mocks.createJobTitleRule,
  upsertJobTitleRule: mocks.upsertJobTitleRule,
}));

// Partially mocked: SectionRenameError is matched with `instanceof`, so the action needs
// the real class.
vi.mock("@/lib/db/org.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/org.repo")>()),
  renameSectionWithAlias: mocks.renameSectionWithAlias,
  updateDepartment: mocks.updateDepartment,
  updateSection: mocks.updateSection,
  upsertSection: mocks.upsertSection,
  loadOrgSnapshot: mocks.loadOrgSnapshot,
}));

vi.mock("@/lib/db/plan.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/plan.repo")>()),
  upsertPlanWithAudit: mocks.upsertPlanWithAudit,
  countPlansByFiscalYear: mocks.countPlansByFiscalYear,
  upsertPlansBulkWithAudit: mocks.upsertPlansBulkWithAudit,
}));

vi.mock("@/lib/db/fiscal-year.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/fiscal-year.repo")>()),
  findFiscalYearById: mocks.findFiscalYearById,
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

vi.mock("@/lib/db/import-log.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/import-log.repo")>()),
  hasSuccessfulImport: mocks.hasSuccessfulImport,
}));

vi.mock("@/lib/attendance/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attendance/ingest")>()),
  ingestAttendanceSource: mocks.ingestAttendanceSource,
  inspectAttendanceSource: mocks.inspectAttendanceSource,
}));

import {
  createSection,
  renameSection,
  saveDepartment,
  saveJobTitleRule,
  saveSection,
} from "@/app/admin/actions";
import { revokeAdjustment, submitActualAdjustments } from "@/app/actuals/adjust/actions";
import { commitAttendanceImport, previewAttendanceImport } from "@/app/actuals/import/actions";
import { savePlanCell } from "@/app/plans/actions";
import { commitPlanImport, previewPlanImport } from "@/app/plans/import/actions";
import { resolveAdjustTarget } from "@/lib/attendance/adjust-window";
import { DENIED_MESSAGE } from "@/lib/auth";

/**
 * The month submitActualAdjustments would accept if it ran, derived the same way the action
 * derives it.
 *
 * Hard-coding a month would make this payload silently fall out of the 只在次月 window as
 * the calendar moved, and a rejected-for-the-wrong-reason payload cannot detect a missing
 * gate - the action would refuse it either way.
 */
const ADJUST_TARGET = resolveAdjustTarget(new Date());

/** The single 課 the adjustment payload below is written against. */
const ADJUST_SECTION_ID = "sec-1";

/**
 * A payload that would OTHERWISE SUCCEED, or at least get far enough to write.
 *
 * This matters: if the payloads were malformed, every assertion below would pass on a
 * completely ungated action, because the shape validation would reject them anyway.
 */
const CALLS: ReadonlyArray<{ name: string; run: () => Promise<{ ok: boolean; message?: string }> }> = [
  {
    name: "saveJobTitleRule",
    run: () =>
      saveJobTitleRule({
        jobTitleRaw: "工场长",
        excludePersonnelHours: true,
        excludeOvertimeHours: true,
        remarkRaw: null,
        isCreate: false,
      }),
  },
  {
    name: "saveDepartment",
    run: () =>
      saveDepartment({
        id: "dep-1",
        codeRaw: "QA",
        sortOrderRaw: "1",
        managerNameRaw: "",
        managerEmailRaw: "",
      }),
  },
  {
    name: "saveSection",
    run: () =>
      saveSection({
        id: "sec-1",
        sortOrderRaw: "18",
        managerNameRaw: "",
        managerEmailRaw: "",
      }),
  },
  {
    name: "renameSection",
    run: () => renameSection({ id: "sec-1", nameRaw: "检査课" }),
  },
  {
    name: "createSection",
    run: () =>
      createSection({
        departmentId: "dep-1",
        nameRaw: "新设课",
        sortOrderRaw: "99",
        managerNameRaw: "",
        managerEmailRaw: "",
      }),
  },
  {
    name: "savePlanCell",
    run: () =>
      savePlanCell({
        fiscalYearId: "fy-2026",
        sectionId: "sec-1",
        month: 1,
        plannedRaw: "1234",
        challengeRaw: "1200",
        reason: "预算调整",
      }),
  },
  {
    name: "previewPlanImport",
    run: () => previewPlanImport(planFormData()),
  },
  {
    name: "commitPlanImport",
    run: () => commitPlanImport(planFormData()),
  },
  {
    name: "previewAttendanceImport",
    run: () => previewAttendanceImport(attendanceFormData()),
  },
  {
    name: "commitAttendanceImport",
    run: () => commitAttendanceImport(attendanceFormData()),
  },
  {
    name: "submitActualAdjustments",
    run: () =>
      submitActualAdjustments({
        fiscalYear: ADJUST_TARGET.fiscalYear,
        month: ADJUST_TARGET.month,
        reason: "人工统计差异修正",
        // The stubbed org chart has this 課 with a base of 0, so the delta is +920 and,
        // per the D-207 carve-out, a base of 0 is not treated as high-risk. An ungated
        // call therefore reaches createActualAdjustmentsBulk rather than stopping at a
        // confirmation prompt.
        entries: { [ADJUST_SECTION_ID]: "920" },
        bases: { [ADJUST_SECTION_ID]: 0 },
        riskAcknowledged: false,
      }),
  },
  {
    name: "revokeAdjustment",
    run: () => revokeAdjustment({ id: "adj-1" }),
  },
];

/** A plan-import payload carrying a fiscal year and a file, as the form posts it. */
function planFormData(): FormData {
  const formData = new FormData();
  formData.set("fiscalYearId", "fy-2026");
  formData.set("file", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "plan.xlsx"));
  return formData;
}

/** An attendance-import payload with the same shape the upload form sends. */
function attendanceFormData(): FormData {
  const formData = new FormData();
  formData.set("fiscalYearId", "fy-2026");
  formData.append(
    "files",
    new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "20260816.xlsx"),
  );
  return formData;
}

/**
 * The minimum stored state that lets an ungated submitActualAdjustments reach its write.
 *
 * Without this the action would die reading the org chart and return its own read-failure
 * message - which is not DENIED_MESSAGE, so the assertion would still pass, but it would
 * pass because the payload crashed rather than because the gate held. That is the exact
 * false-green this file's header warns about.
 */
function stubAdjustmentReads(): void {
  mocks.loadOrgSnapshot.mockResolvedValue({
    departments: [
      {
        id: "dep-1",
        name: "品质保证部",
        code: "QA",
        sortOrder: 1,
        managerName: null,
        managerEmail: null,
      },
    ],
    sections: [
      {
        id: ADJUST_SECTION_ID,
        departmentId: "dep-1",
        name: "检査课",
        sortOrder: 1,
        managerName: null,
        managerEmail: null,
      },
    ],
  });
  mocks.findFiscalYearByYear.mockResolvedValue({
    id: "fy-adjust",
    name: `FY${String(ADJUST_TARGET.fiscalYear)}`,
    year: ADJUST_TARGET.fiscalYear,
    startDate: new Date(Date.UTC(ADJUST_TARGET.fiscalYear, 3, 1)),
    endDate: new Date(Date.UTC(ADJUST_TARGET.fiscalYear + 1, 2, 31)),
    isCurrent: true,
  });
  // No folded rows: every cell reads 0, which is a legal state (D-207) and keeps the
  // fixture from encoding a particular month's attendance data.
  mocks.findEffectiveActualsByFiscalYear.mockResolvedValue({ rows: [], adjustedMonths: [] });
  mocks.createActualAdjustmentsBulk.mockResolvedValue(1);
  mocks.revokeActualAdjustment.mockResolvedValue(true);
}

/** Every mocked repository write, for the "nothing was touched" assertion. */
const WRITES = [
  mocks.createJobTitleRule,
  mocks.upsertJobTitleRule,
  mocks.renameSectionWithAlias,
  mocks.updateDepartment,
  mocks.updateSection,
  mocks.upsertSection,
  mocks.upsertPlanWithAudit,
  mocks.upsertPlansBulkWithAudit,
  mocks.ingestAttendanceSource,
  mocks.createActualAdjustmentsBulk,
  mocks.revokeActualAdjustment,
] as const;

beforeEach(() => {
  // A configured deployment - the point being that these actions refuse anyway, because
  // the CALLER has no session. Leaving SESSION_SECRET unset would make every assertion
  // pass for the wrong reason (fail-closed on config rather than on identity).
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.ADMIN_PASSWORD = "correct horse";

  // No cookie: this is the anonymous shop-floor browser, and the curl probe.
  mocks.cookieGet.mockReset();
  mocks.cookieGet.mockReturnValue(undefined);

  mocks.revalidatePath.mockReset();
  for (const write of WRITES) {
    write.mockReset();
  }

  mocks.loadOrgSnapshot.mockReset();
  mocks.findFiscalYearByYear.mockReset();
  mocks.findEffectiveActualsByFiscalYear.mockReset();
  stubAdjustmentReads();

  // Silences the expected "[auth] denied: no-cookie" line, and would fail loudly if the
  // gate stopped logging.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("Server Action gates - an anonymous caller is refused by all twelve actions", () => {
  it.each(CALLS.map((call) => [call.name, call] as const))(
    "%s refuses without a session",
    async (_name, call) => {
      const result = await call.run();

      expect(result.ok).toBe(false);
      // The one message an ungated action cannot produce - see the file header.
      expect(result.message).toBe(DENIED_MESSAGE);
    },
  );

  it("covers all twelve actions in the permission boundary", () => {
    // Pinned so a new Server Action added without a gate shows up as a failing count
    // rather than as an untested write path.
    expect(CALLS).toHaveLength(12);
  });

  it("writes nothing to the database across all twelve refusals", async () => {
    for (const call of CALLS) {
      await call.run();
    }

    for (const write of WRITES) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("does not revalidate any path", async () => {
    for (const call of CALLS) {
      await call.run();
    }

    // Revalidating on a refused call would re-render the page as though something had
    // changed, which is how a rejected write comes to look like an applied one.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an expired cookie the same way as no cookie at all", async () => {
    mocks.cookieGet.mockImplementation((name) =>
      // Well-formed but ancient, and signed with a secret that is not the configured
      // one - the shape a captured or stale cookie has.
      name === "mh_admin" ? { name, value: `1000000000000.${"a".repeat(64)}` } : undefined,
    );

    for (const call of CALLS) {
      const result = await call.run();

      expect(result.ok).toBe(false);
      expect(result.message).toBe(DENIED_MESSAGE);
    }
  });
});
