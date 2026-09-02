// D-229 acceptance: soft supersede, and the sharp-drop guard that limits it.
//
// The feature exists because row-level upsert cannot express a deletion. HR publishes the
// same 出勤日期 twice a day (09:05 and 15:05, D-228); overwriting only touches keys the
// incoming file carries, so a row HR removed between the two fetches would survive as a
// ghost and keep feeding the monthly aggregate. Every failure mode here is SILENT - a
// ghost row renders as a perfectly normal bar - which is why each one gets a case.
//
// Unlike actual-baseline.test.ts, whose fake only COUNTS calls, this suite emulates
// storage: half of what has to be proven is about state ("the row is still in the table",
// "the month fell by exactly that much"), and a call-counting fake cannot see either.
//
// The fake's where-matcher is deliberately generic - equality, `not`, `gte`/`lte`,
// `in`/`notIn` - and THROWS on any operator it does not know. A fake hand-tailored to the
// clauses the repository happens to emit today would agree with a wrong clause just as
// happily as with a right one.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedAttendanceRow } from "@/lib/attendance/parser";

/** Mutable table state, hoisted so the vi.mock factory below can close over it. */
const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}));

/** Date-aware equality: Prisma compares DateTime by value, `===` compares by reference. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/** Range operands must be Dates here; anything else means the clause changed shape. */
function asTime(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  throw new Error(`fake store: range operator needs a Date, got ${typeof value}`);
}

/**
 * Minimal Prisma `where` evaluator.
 *
 * Throws on an unrecognised operator rather than ignoring it. That is the property that
 * makes the assertions in this file mean something: silently skipping an operator would
 * turn `sourceFile: { not: x }` into "match everything" and every case would still pass.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition === null || condition instanceof Date || typeof condition !== "object") {
      return sameValue(value, condition);
    }
    const ops = condition as Record<string, unknown>;
    for (const op of Object.keys(ops)) {
      if (!["not", "gte", "lte", "in", "notIn"].includes(op)) {
        throw new Error(`fake store: unsupported operator "${op}" on field "${field}"`);
      }
    }
    if ("not" in ops && sameValue(value, ops["not"])) {
      return false;
    }
    if ("gte" in ops && asTime(value) < asTime(ops["gte"])) {
      return false;
    }
    if ("lte" in ops && asTime(value) > asTime(ops["lte"])) {
      return false;
    }
    if ("in" in ops && !(ops["in"] as unknown[]).some((v) => sameValue(value, v))) {
      return false;
    }
    if ("notIn" in ops && (ops["notIn"] as unknown[]).some((v) => sameValue(value, v))) {
      return false;
    }
    return true;
  });
}

// Rows are replaced, never mutated in place, so a reference handed to production code
// cannot be changed underneath it - the same immutability the repository itself follows.
vi.mock("@/lib/prisma", () => {
  const attendanceRaw = {
    upsert: async (args: {
      where: { employeeNo_workDate: { employeeNo: string; workDate: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = args.where.employeeNo_workDate;
      const index = store.rows.findIndex(
        (row) =>
          sameValue(row["employeeNo"], key.employeeNo) &&
          sameValue(row["workDate"], key.workDate),
      );
      if (index === -1) {
        const id = `raw-${String(store.rows.length + 1)}`;
        store.rows = [...store.rows, { id, ...args.create }];
        return { id };
      }
      const existing = store.rows[index] as Record<string, unknown>;
      const merged = { ...existing, ...args.update };
      store.rows = store.rows.map((row, i) => (i === index ? merged : row));
      return { id: merged["id"] as string };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      store.rows.filter((row) => matchesWhere(row, where)).length,
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      store.rows = store.rows.map((row) => {
        if (!matchesWhere(row, where)) {
          return row;
        }
        count += 1;
        return { ...row, ...data };
      });
      return { count };
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      store.rows.filter((row) => matchesWhere(row, where)).map((row) => ({ ...row })),
  };
  const delegates = {
    attendanceRaw,
    // No manual baseline anywhere in this suite - D-198 has its own file. upsert/deleteMany
    // are accepted and discarded: what the month aggregates to is asserted through
    // MonthRebuildResult, which reports what the fold READ.
    actual: {
      count: async () => 0,
      upsert: async () => ({ id: "actual-1" }),
      deleteMany: async () => ({ count: 0 }),
    },
    fiscalYear: {
      findMany: async () => [{ id: "fy-2026", year: 2026 }],
    },
  };
  return {
    prisma: {
      ...delegates,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(delegates),
    },
  };
});

// Empty org master: every row lands in the unattributed bucket, which is enough here.
// This suite asserts how MANY rows the fold saw, not which section they belong to.
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
  countAttendanceRowsInMonth,
  findUnattributedHours,
  importAttendanceRows,
} from "@/lib/db/attendance.repo";
import { parseDateOnly } from "@/lib/db/date";

/** 2026-08-25 is fiscal 2026 month 5 (August); the real samples both carry this date. */
const WORK_DATE = "2026-08-25";
const AUGUST = { fiscalYear: 2026, month: 5 } as const;

const MORNING_FILE = "日考勤数据260826_0900.csv";
const AFTERNOON_FILE = "日考勤数据260826_1500.csv";

function row(employeeNo: string, workHours = 8, workDate = WORK_DATE): ParsedAttendanceRow {
  return {
    excelRow: 2,
    employeeNo,
    employeeName: `测试${employeeNo}`,
    workDate: parseDateOnly(workDate),
    hrDeptName: "制造部",
    hrSectionName: "生产1課",
    jobTitle: "班長",
    employeeCategory: "正式員工",
    leaveHours: 0,
    workHours,
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

/** `count` employees numbered from 10001, all on the same day. */
function rows(count: number, workHours = 8): ParsedAttendanceRow[] {
  return Array.from({ length: count }, (_, i) =>
    row(String(10001 + i), workHours),
  );
}

/** Reads the raw table directly - the only way to see a row the repository filters out. */
function storedRow(employeeNo: string): Record<string, unknown> | undefined {
  return store.rows.find((r) => r["employeeNo"] === employeeNo);
}

/** Rows a read path would see: the supersede filter applied by hand. */
function liveEmployeeNos(): string[] {
  return store.rows
    .filter((r) => r["supersededAt"] === null)
    .map((r) => r["employeeNo"] as string)
    .sort();
}

/** The scheduled-fetch caller: a clean parse, so supersede is armed. */
async function importAsScheduledFetch(
  parsed: readonly ParsedAttendanceRow[],
  fileName: string,
  fetchedAt = new Date("2026-08-26T07:05:00Z"),
) {
  return importAttendanceRows(parsed, fileName, fetchedAt, { supersedeMissing: true });
}

beforeEach(() => {
  store.rows = [];
});

describe("supersede is opt-in", () => {
  it("never supersedes when the caller does not ask", async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);

    // The default path - a PARTIAL parse, or any caller that did not pass the flag.
    const result = await importAttendanceRows(rows(3), AFTERNOON_FILE);

    expect(result.supersededCount).toBe(0);
    expect(result.supersedeSkipped).toEqual([]);
    // All five stay live: the two the afternoon file dropped are NOT removed, which is
    // exactly the pre-D-229 behaviour a distrusted file must keep getting.
    expect(liveEmployeeNos()).toHaveLength(5);
  });

  it("stores zero rows and supersedes nothing on an empty parse", async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);

    // D-229 boundary 6, and the most dangerous case in the feature: a rest-day export
    // holding only the totals row parses to zero rows and D-209 still calls it SUCCESS.
    // Superseding on it would erase the whole day.
    const result = await importAsScheduledFetch([], AFTERNOON_FILE);

    expect(result.rowsStored).toBe(0);
    expect(result.months).toEqual([]);
    expect(result.supersededCount).toBe(0);
    expect(liveEmployeeNos()).toHaveLength(5);
  });
});

describe("a changed value is not a deletion", () => {
  it("updates in place and supersedes nothing when the roster is unchanged", async () => {
    await importAsScheduledFetch(rows(3, 8), MORNING_FILE);

    const result = await importAsScheduledFetch(rows(3, 9.5), AFTERNOON_FILE);

    expect(result.supersededCount).toBe(0);
    expect(liveEmployeeNos()).toEqual(["10001", "10002", "10003"]);
    // "later file wins" is the upsert's job, not the supersede pass's - asserted here so a
    // future change to the supersede logic cannot quietly break the correction path.
    expect(storedRow("10001")?.["workHours"]).toBe(9.5);
    expect(storedRow("10001")?.["sourceFile"]).toBe(AFTERNOON_FILE);
  });
});

describe("a removed row is superseded, not deleted", () => {
  it("marks the dropped row and drops it out of the month", async () => {
    const morning = await importAsScheduledFetch(rows(5), MORNING_FILE);
    expect(morning.months[0]?.sourceRows).toBe(5);

    // 4 of 5 is exactly a 20% reduction - allowed, because the guard fires on MORE than
    // 20%. Deliberately sitting on the boundary: an off-by-one in the comparison would
    // suppress a legitimate supersede and the totals would silently stay too high.
    const afternoon = await importAsScheduledFetch(rows(4), AFTERNOON_FILE);

    expect(afternoon.supersededCount).toBe(1);
    expect(afternoon.supersedeSkipped).toEqual([]);
    expect(liveEmployeeNos()).toEqual(["10001", "10002", "10003", "10004"]);

    // Propagation to the aggregate is free because the rebuild is a full-month recompute:
    // the row simply stops being read and the month falls by exactly that much.
    expect(afternoon.months[0]?.sourceRows).toBe(4);
    expect(afternoon.months[0]?.unattributedHours).toBe(32);
  });

  it("keeps the superseded row in the table, with its provenance", async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);
    const fetchedAt = new Date("2026-08-26T15:05:00Z");

    await importAsScheduledFetch(rows(4), AFTERNOON_FILE, fetchedAt);

    // The reverse guard. D-206 is 不做删除、长期保留, and raw detail is not recomputable:
    // hard-deleting would erase the fact that HR once reported this row, which is the one
    // thing the audit trail exists to preserve.
    const dropped = storedRow("10005");
    expect(dropped).toBeDefined();
    expect(store.rows).toHaveLength(5);
    expect(dropped?.["supersededAt"]).toEqual(fetchedAt);
    expect(dropped?.["supersededBy"]).toBe(AFTERNOON_FILE);
    // Still carries the file that WROTE it, so "which file brought it, which took it away"
    // are two separate readable facts.
    expect(dropped?.["sourceFile"]).toBe(MORNING_FILE);
  });

  it("supersedes only the day the file covers", async () => {
    // 10 rows on 08-25 so the afternoon file's 8 stay inside the guard, plus one row on
    // 08-24 that the afternoon file says nothing about.
    await importAsScheduledFetch(
      [...rows(10), row("20001", 8, "2026-08-24")],
      MORNING_FILE,
    );

    // The afternoon file carries 08-25 only. 08-24 is not in it - and absence from a file
    // that never claimed to cover that day is not a deletion. Scoping the supersede to the
    // dates the file actually contains, rather than to the month it falls in, is what makes
    // this hold; a month-wide sweep would erase every earlier day on the first fetch.
    const result = await importAsScheduledFetch(rows(8), AFTERNOON_FILE);

    expect(result.supersededCount).toBe(2);
    expect(storedRow("10009")?.["supersededBy"]).toBe(AFTERNOON_FILE);
    expect(storedRow("10010")?.["supersededBy"]).toBe(AFTERNOON_FILE);
    // The 08-24 row is untouched, and its day was never even measured by the guard.
    expect(storedRow("20001")?.["supersededAt"]).toBeNull();
    expect(liveEmployeeNos()).toHaveLength(9);
  });

  it("is idempotent when the same file is imported twice", async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);
    await importAsScheduledFetch(rows(4), AFTERNOON_FILE);

    // Rows are identified by `sourceFile: { not: <this file> }`, so a re-run matches
    // nothing. A retry after a partial failure must not keep eating the day.
    const again = await importAsScheduledFetch(rows(4), AFTERNOON_FILE);

    expect(again.supersededCount).toBe(0);
    expect(liveEmployeeNos()).toHaveLength(4);
  });

  it("brings a row back to life when it reappears", async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);
    await importAsScheduledFetch(rows(4), AFTERNOON_FILE);
    expect(liveEmployeeNos()).toHaveLength(4);

    // HR removed someone in the morning and restored them in the afternoon. Every write
    // clears the supersede mark, so a restored row rejoins the totals instead of staying
    // invisible forever.
    const corrected = await importAsScheduledFetch(rows(5), "日考勤数据260826_1800.csv");

    expect(liveEmployeeNos()).toHaveLength(5);
    expect(storedRow("10005")?.["supersededAt"]).toBeNull();
    expect(storedRow("10005")?.["supersededBy"]).toBeNull();
    expect(corrected.months[0]?.sourceRows).toBe(5);
  });
});

describe("sharp-drop guard", () => {
  it("suppresses supersede when the day loses more than 20% of its rows", async () => {
    await importAsScheduledFetch(rows(10), MORNING_FILE);

    // The measured failure mode, not a hypothetical one: the two real samples both carried
    // 出勤日期 2026-08-25 yet held 580 and 183 rows. Trusting the narrow one would erase
    // ~400 people's day and the monthly total would faithfully follow it down.
    const result = await importAsScheduledFetch(rows(2), AFTERNOON_FILE);

    expect(result.supersededCount).toBe(0);
    expect(liveEmployeeNos()).toHaveLength(10);
    // Data still gets updated - the file is not rejected, only its authority to delete is.
    expect(result.rowsStored).toBe(2);
    expect(result.months[0]?.sourceRows).toBe(10);
  });

  it("fires at 21% but not at 20%", async () => {
    await importAsScheduledFetch(rows(100), MORNING_FILE);
    const allowed = await importAsScheduledFetch(rows(80), AFTERNOON_FILE);
    expect(allowed.supersededCount).toBe(20);

    store.rows = [];
    await importAsScheduledFetch(rows(100), MORNING_FILE);
    const blocked = await importAsScheduledFetch(rows(79), AFTERNOON_FILE);
    expect(blocked.supersededCount).toBe(0);
    expect(blocked.supersedeSkipped).toHaveLength(1);
  });

  it("names the day and both counts, so the operator can check the export", async () => {
    await importAsScheduledFetch(rows(10), MORNING_FILE);

    const result = await importAsScheduledFetch(rows(2), AFTERNOON_FILE);

    const message = result.supersedeSkipped[0] ?? "";
    expect(message).toContain("2026-08-25");
    expect(message).toContain("仅含 2 行");
    expect(message).toContain("现有 10 行");
    expect(message).toContain("减少超过 20%");
  });

  it("does not fire on the first import of a day", async () => {
    // before === 0, so the comparison is false and the supersede below matches nothing.
    // No special case in the code, so this asserts the arithmetic rather than a branch.
    const result = await importAsScheduledFetch(rows(3), MORNING_FILE);

    expect(result.supersededCount).toBe(0);
    expect(result.supersedeSkipped).toEqual([]);
    expect(liveEmployeeNos()).toHaveLength(3);
  });

  it("measures the day as it stood BEFORE this file's own rows landed", async () => {
    await importAsScheduledFetch(rows(10), MORNING_FILE);

    // The one scenario where the two orderings disagree: a file that ADDS people while
    // removing others. 4 of the original 10, plus 8 new hires. Baseline read BEFORE the
    // upserts is 10, and 12 >= 8, so supersede proceeds. Read AFTER, the baseline would
    // be 18 - the 8 rows this very file just inserted counted as pre-existing - and
    // 12 < 14.4 would suppress the supersede on entirely invented evidence.
    const result = await importAsScheduledFetch(
      [
        ...Array.from({ length: 4 }, (_, i) => row(String(10001 + i))),
        ...Array.from({ length: 8 }, (_, i) => row(String(20001 + i))),
      ],
      AFTERNOON_FILE,
    );

    expect(result.supersededCount).toBe(6);
    expect(storedRow("10005")?.["supersededBy"]).toBe(AFTERNOON_FILE);
    expect(liveEmployeeNos()).toHaveLength(12);
  });

  it("compares row COUNTS, so churn can hide a large deletion", async () => {
    await importAsScheduledFetch(rows(10), MORNING_FILE);

    // Locking a known limitation rather than a desired behaviour. The guard measures
    // `incoming < live * 0.8`, which is a size comparison, not a set-overlap one: a file
    // that keeps 4 people and brings 8 new ones is bigger than the day it replaces, so
    // the guard stays quiet while 60% of the roster is superseded.
    //
    // Left as-is deliberately. Reaching the divergence needs >20% roster turnover inside
    // half a day, which at ~580 staff means 116 people replaced between 09:05 and 15:05.
    // Recorded here so the next person to touch the threshold knows the metric is
    // "how big is this file", not "how much would this delete".
    const result = await importAsScheduledFetch(
      [
        ...Array.from({ length: 4 }, (_, i) => row(String(10001 + i))),
        ...Array.from({ length: 8 }, (_, i) => row(String(20001 + i))),
      ],
      AFTERNOON_FILE,
    );

    expect(result.supersedeSkipped).toEqual([]);
    expect(result.supersededCount).toBe(6);
  });
});

describe("read paths exclude superseded rows", () => {
  beforeEach(async () => {
    await importAsScheduledFetch(rows(5), MORNING_FILE);
    await importAsScheduledFetch(rows(4), AFTERNOON_FILE);
  });

  it("countAttendanceRowsInMonth counts only live rows", async () => {
    // This feeds the gate-4 / gate-6 acceptance check. Counting the ghost would report the
    // day as more complete than it is.
    expect(await countAttendanceRowsInMonth(AUGUST)).toBe(4);
  });

  it("findUnattributedHours drops the superseded row from the banner", async () => {
    const result = await findUnattributedHours(AUGUST);

    // A superseded row must not keep the /actuals warning banner lit for hours that no
    // longer count towards anything.
    expect(result.rows).toBe(4);
    expect(result.hours).toBe(32);
  });
});
