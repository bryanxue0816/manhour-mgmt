// D-198 acceptance: the hand-typed actual baseline and the guard that protects it.
//
// Three things are checked here, and each one exists because its failure mode is SILENT.
//
// 1. The calendar -> fiscal month conversion. `Actual.month` is a fiscal ordinal where
//    1 = April, while the sheet the operator fills in says "2026年4月". Copying the
//    number across files April's hours as July's: no error, no exception, no log line,
//    and a chart that renders perfectly. This is the regression test for that shift.
//
// 2. The `source` vocabulary. SQLite has no enum, so the module IS the constraint. A
//    value that slips past it matches none of the three queries that filter on `source`,
//    which means the guard below stops guarding while still reading as correct.
//
// 3. The refusal itself. A month holding a hand-typed baseline has no attendance detail
//    behind it, so re-folding it writes zeros - and zero renders as a bar of no height,
//    not as a failure. Both layers of the guard are checked: the early one in
//    importAttendanceRows() (which must refuse with attendance_raw untouched) and the
//    in-transaction one in rebuildMonthlyActuals() (the only race-free one, and the only
//    one recomputeMonth() passes through).
//
// `attendance.repo.ts` imports `@/lib/prisma`, which builds a better-sqlite3 client at
// module load, so this suite mocks that module - same reason `master-data-audit.test.ts`
// does. The fake counts calls rather than emulating storage: what matters here is not
// what a write would have produced but that NO write was attempted.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedAttendanceRow } from "@/lib/attendance/parser";

const mocks = vi.hoisted(() => ({
  actualCount: vi.fn(),
  actualUpsert: vi.fn(),
  actualDeleteMany: vi.fn(),
  attendanceRawUpsert: vi.fn(),
  attendanceRawFindMany: vi.fn(),
  fiscalYearFindMany: vi.fn(),
}));

// Hoisted above the imports below, so the repo never builds a real client. `$transaction`
// runs the callback against the same delegates the outer client exposes: the guard has to
// be reached through both, and a tx that silently did nothing would make the test pass
// for the wrong reason.
vi.mock("@/lib/prisma", () => {
  const delegates = {
    actual: {
      count: mocks.actualCount,
      upsert: mocks.actualUpsert,
      deleteMany: mocks.actualDeleteMany,
    },
    attendanceRaw: {
      upsert: mocks.attendanceRawUpsert,
      findMany: mocks.attendanceRawFindMany,
    },
    fiscalYear: { findMany: mocks.fiscalYearFindMany },
  };
  return {
    prisma: {
      ...delegates,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(delegates),
    },
  };
});

// The three master reads behind loadAttendanceCalcContext(). Stubbed to empty rather than
// mocked out, because importAttendanceRows() computes every row BEFORE it reaches the
// guard: an empty org master leaves the rows unattributed, which is fine - this suite
// asserts that nothing was written, not what the figures would have been.
vi.mock("@/lib/db/org.repo", () => ({
  loadOrgSnapshot: async () => ({ departments: [], sections: [] }),
}));
vi.mock("@/lib/db/section-alias.repo", () => ({
  loadSectionAliasMap: async () => new Map<string, string>(),
}));
vi.mock("@/lib/db/job-title-rule.repo", () => ({
  findAllJobTitleRules: async () => [],
}));

import {
  ACTUAL_SOURCES,
  ACTUAL_SOURCE_FOLD,
  ACTUAL_SOURCE_LABELS,
  ACTUAL_SOURCE_MANUAL,
  assertActualSource,
  isManualBaseline,
} from "@/lib/db/actual-source";
import {
  importAttendanceRows,
  rebuildMonthlyActuals,
} from "@/lib/db/attendance.repo";
import { fiscalMonthFromCalendarLabel, fiscalMonthLabel, parseDateOnly } from "@/lib/db/date";

// --------------------------------------------------------------------------------
// 1. Calendar label -> fiscal month
// --------------------------------------------------------------------------------

describe("fiscalMonthFromCalendarLabel", () => {
  // The four months actually imported, spelled out rather than computed: a loop that
  // derived the expectation with the same offset the function uses would agree with a
  // wrong offset just as happily.
  it.each([
    ["2026年4月", 1],
    ["2026年5月", 2],
    ["2026年6月", 3],
    ["2026年7月", 4],
  ])("maps %s of FY2026 to fiscal month %i", (label, expected) => {
    expect(fiscalMonthFromCalendarLabel(label, 2026)).toBe(expected);
  });

  it("maps the whole fiscal year, April through the following March", () => {
    const labels = [
      "2026年4月",
      "2026年5月",
      "2026年6月",
      "2026年7月",
      "2026年8月",
      "2026年9月",
      "2026年10月",
      "2026年11月",
      "2026年12月",
      "2027年1月",
      "2027年2月",
      "2027年3月",
    ];
    expect(labels.map((label) => fiscalMonthFromCalendarLabel(label, 2026))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("round-trips through fiscalMonthLabel", () => {
    // 26/04 -> 1 -> 26/04. Two independent conversions disagreeing is the shift.
    for (let month = 1; month <= 12; month += 1) {
      const short = fiscalMonthLabel(2026, month);
      const [yy = "", mm = ""] = short.split("/");
      const label = `20${yy}年${String(Number(mm))}月`;
      expect(fiscalMonthFromCalendarLabel(label, 2026)).toBe(month);
    }
  });

  it("accepts a zero-padded month", () => {
    expect(fiscalMonthFromCalendarLabel("2026年04月", 2026)).toBe(1);
  });

  it("rejects a month belonging to another fiscal year", () => {
    // 2027年4月 is FY2027 month 1. Accepted as FY2026 it would collide with April.
    expect(() => fiscalMonthFromCalendarLabel("2027年4月", 2026)).toThrow(/FY2027/);
    // 2026年3月 is the TAIL of FY2025 - the boundary that makes the offset non-obvious.
    expect(() => fiscalMonthFromCalendarLabel("2026年3月", 2026)).toThrow(/FY2025/);
  });

  it.each(["2026-04", "2026年13月", "四月", "", "2026年0月", "26年4月"])(
    "rejects the malformed label %o",
    (label) => {
      expect(() => fiscalMonthFromCalendarLabel(label, 2026)).toThrow();
    },
  );
});

// --------------------------------------------------------------------------------
// 2. The `source` vocabulary
// --------------------------------------------------------------------------------

describe("actual source vocabulary", () => {
  it("exposes exactly the two stored values", () => {
    expect([...ACTUAL_SOURCES]).toEqual(["fold", "manual"]);
    expect(ACTUAL_SOURCE_FOLD).toBe("fold");
    expect(ACTUAL_SOURCE_MANUAL).toBe("manual");
  });

  it("labels both values for the UI", () => {
    expect(Object.keys(ACTUAL_SOURCE_LABELS).sort()).toEqual([...ACTUAL_SOURCES].sort());
    for (const value of ACTUAL_SOURCES) {
      expect(ACTUAL_SOURCE_LABELS[value]).not.toBe("");
    }
  });

  it("accepts the two values verbatim", () => {
    expect(assertActualSource("fold")).toBe("fold");
    expect(assertActualSource("manual")).toBe("manual");
  });

  it.each(["Manual", "MANUAL", " manual", "manual ", "hand", "", "fold,manual"])(
    "rejects %o - no trim, no case folding",
    (value) => {
      expect(() => assertActualSource(value)).toThrow();
    },
  );

  it("names the allowed values in the failure, so the caller can fix the call", () => {
    expect(() => assertActualSource("Manual")).toThrow(/fold/);
    expect(() => assertActualSource("Manual")).toThrow(/manual/);
  });

  it("recognises the manual baseline and only the manual baseline", () => {
    expect(isManualBaseline(ACTUAL_SOURCE_MANUAL)).toBe(true);
    expect(isManualBaseline(ACTUAL_SOURCE_FOLD)).toBe(false);
    // Not a silent false: an unknown value means the CALLER is wrong, and answering
    // "not manual" would let a rebuild proceed on a month nobody has classified.
    expect(() => isManualBaseline("Manual")).toThrow();
  });
});

// --------------------------------------------------------------------------------
// 3. The refusal
// --------------------------------------------------------------------------------

const EMPTY_CONTEXT = {
  sectionIndex: new Map<string, string>(),
  aliasIndex: new Map<string, string>(),
  ruleIndex: new Map(),
};

/** One parsed day row, enough to reach the guard. Values are irrelevant to the outcome. */
function row(workDate: string): ParsedAttendanceRow {
  return {
    excelRow: 2,
    employeeNo: "10001",
    employeeName: "测试",
    workDate: parseDateOnly(workDate),
    hrDeptName: "制造部",
    hrSectionName: "生产1课",
    jobTitle: "班长",
    employeeCategory: "正式员工",
    leaveHours: 0,
    workHours: 8,
    normalOvertime: 0,
    restDayDouble: 0,
    holidayOvertime: 0,
    restDayCompensate: 0,
    compensatoryLeave: 0,
    maternityLeave: 0,
    nursingLeave: 0,
    miscarriageLeave: 0,
  };
}

describe("manual-baseline guard (D-198)", () => {
  beforeEach(() => {
    mocks.actualCount.mockReset();
    mocks.actualUpsert.mockReset();
    mocks.actualDeleteMany.mockReset();
    mocks.attendanceRawUpsert.mockReset();
    mocks.attendanceRawFindMany.mockReset();
    mocks.fiscalYearFindMany.mockReset();
    mocks.fiscalYearFindMany.mockResolvedValue([{ id: "fy-2026", year: 2026 }]);
    mocks.attendanceRawFindMany.mockResolvedValue([]);
  });

  describe("rebuildMonthlyActuals", () => {
    it("refuses a month holding a manual row, writing and deleting nothing", async () => {
      mocks.actualCount.mockResolvedValue(1);

      await expect(
        rebuildMonthlyActuals({ fiscalYear: 2026, month: 1 }, "fy-2026", EMPTY_CONTEXT),
      ).rejects.toThrow(/手工基线/);

      // The deleteMany below the guard is scoped only by (fiscalYearId, month): reaching
      // it would take the baseline with it, which is the whole failure this prevents.
      expect(mocks.actualDeleteMany).not.toHaveBeenCalled();
      expect(mocks.actualUpsert).not.toHaveBeenCalled();
      // Refused BEFORE the read, not after computing a zero fold and declining to store it.
      expect(mocks.attendanceRawFindMany).not.toHaveBeenCalled();
    });

    it("counts only manual rows, inside the transaction", async () => {
      mocks.actualCount.mockResolvedValue(1);

      await expect(
        rebuildMonthlyActuals({ fiscalYear: 2026, month: 3 }, "fy-2026", EMPTY_CONTEXT),
      ).rejects.toThrow();

      expect(mocks.actualCount).toHaveBeenCalledWith({
        where: { fiscalYearId: "fy-2026", month: 3, source: "manual" },
      });
    });

    it("names the month it refused, so the operator knows which one to clear", async () => {
      mocks.actualCount.mockResolvedValue(1);

      await expect(
        rebuildMonthlyActuals({ fiscalYear: 2026, month: 4 }, "fy-2026", EMPTY_CONTEXT),
      ).rejects.toThrow(/26\/07/);
    });

    it("proceeds when the month holds no manual row", async () => {
      mocks.actualCount.mockResolvedValue(0);

      const result = await rebuildMonthlyActuals(
        { fiscalYear: 2026, month: 1 },
        "fy-2026",
        EMPTY_CONTEXT,
      );

      // No stored rows, so nothing to upsert - but the read DID happen and the stale-row
      // cleanup DID run, which is what distinguishes "allowed through" from "refused".
      expect(mocks.attendanceRawFindMany).toHaveBeenCalledTimes(1);
      expect(mocks.actualDeleteMany).toHaveBeenCalledTimes(1);
      expect(result.sourceRows).toBe(0);
      expect(result.actualRows).toBe(0);
    });
  });

  describe("importAttendanceRows", () => {
    it("refuses before attendance_raw is written", async () => {
      mocks.actualCount.mockResolvedValue(1);

      await expect(
        importAttendanceRows([row("2026-04-15")], "2026-04.xlsx"),
      ).rejects.toThrow(/手工基线/);

      // The day rows and the month rebuild are separate transactions, so a refusal at
      // rebuild time would leave attendance_raw committed against a month that never got
      // re-folded - two tables disagreeing with nothing on screen to reveal it.
      expect(mocks.attendanceRawUpsert).not.toHaveBeenCalled();
      expect(mocks.actualUpsert).not.toHaveBeenCalled();
      expect(mocks.actualDeleteMany).not.toHaveBeenCalled();
    });

    it("lists every blocked month, not just the first", async () => {
      mocks.actualCount.mockResolvedValue(1);

      // April and May in one file: a backfill spanning a month boundary is well-defined
      // (D-120), and being told about only one of them costs a second failed attempt.
      const error = await importAttendanceRows(
        [row("2026-04-30"), row("2026-05-01")],
        "backfill.xlsx",
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("26/04");
      expect((error as Error).message).toContain("26/05");
    });

    it("stores and rebuilds when no month holds a manual row", async () => {
      mocks.actualCount.mockResolvedValue(0);

      const result = await importAttendanceRows([row("2026-04-15")], "2026-04.xlsx");

      expect(mocks.attendanceRawUpsert).toHaveBeenCalledTimes(1);
      expect(result.rowsStored).toBe(1);
      expect(result.months).toHaveLength(1);
      expect(result.months[0]?.month).toBe(1);
    });
  });
});
