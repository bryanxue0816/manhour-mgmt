// renameSectionWithAlias(): the rename that must not lose history.
//
// Why this function needs its own suite. resolveSectionId() in lib/attendance/calc.ts
// looks a row up by aliasKey(部名, 課名) against an index built from the CURRENT section
// names, falls back to the alias table, and returns `null` on a double miss - and
// `null` is a warning, never a rejection (D-164). So a rename that commits without its
// alias sends every historical HR row carrying the old spelling into the 未归属 bucket
// with no error anywhere. There is no failing test to notice afterwards; the numbers
// just quietly move. That makes "name and alias share one transaction" the load-bearing
// property, and it is what the atomicity cases below pin.
//
// `org.repo.ts` imports `@/lib/prisma`, which builds a better-sqlite3 PrismaClient at
// module load, so that module is mocked - same reason master-data-audit.test.ts exists
// as its own file: a unit test must not need a database.
//
// The fake is a transaction emulator, not a database: it stages a deep copy, hands the
// repo a client over that copy, and merges it back only if the callback resolves. It
// proves the COMPOSITION is one atomic unit - it does not claim to prove SQLite's
// rollback, which is Prisma's job and is checked against the real database separately.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.$transaction },
}));

import { SectionRenameError, renameSectionWithAlias } from "@/lib/db/org.repo";

// --------------------------------------------------------------------------------
// Fake store
// --------------------------------------------------------------------------------

interface DeptRow {
  id: string;
  name: string;
  code: string | null;
  sortOrder: number;
  managerName: string | null;
  managerEmail: string | null;
}

interface SectionRow {
  id: string;
  departmentId: string;
  name: string;
  sortOrder: number;
  managerName: string | null;
  managerEmail: string | null;
}

interface AliasRow {
  hrDeptName: string;
  hrSectionName: string;
  sectionId: string;
  remark: string | null;
}

interface LogRow {
  entity: string;
  action: string;
  targetKey: string;
  snapshot: string;
}

interface FakeDb {
  departments: DeptRow[];
  sections: SectionRow[];
  aliases: AliasRow[];
  log: LogRow[];
  /** Makes `masterDataChangeLog.create` throw once this many rows exist. */
  failLogCreateAfter: number;
}

const DEPT_NAME = "品质保证部";

function freshDb(): FakeDb {
  return {
    departments: [
      {
        id: "dep-q",
        name: DEPT_NAME,
        code: null,
        sortOrder: 6,
        managerName: null,
        managerEmail: null,
      },
    ],
    sections: [
      {
        id: "sec-kensa",
        departmentId: "dep-q",
        name: "検査课",
        sortOrder: 18,
        managerName: "王某",
        managerEmail: null,
      },
      {
        id: "sec-hinsho",
        departmentId: "dep-q",
        name: "品证课",
        sortOrder: 19,
        managerName: null,
        managerEmail: null,
      },
    ],
    aliases: [],
    log: [],
    failLogCreateAfter: Number.POSITIVE_INFINITY,
  };
}

let db: FakeDb;

/** Applies a Prisma `select` projection, since the stored snapshot format depends on it. */
function project<T extends Record<string, unknown>>(
  row: T,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  if (select === undefined) {
    return { ...row };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    out[key] = row[key];
  }
  return out;
}

function sortByOrderThenName<T extends { sortOrder: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.name.localeCompare(b.name) : a.sortOrder - b.sortOrder,
  );
}

/** A transaction client over `state`; every read and write hits that copy only. */
function clientOver(state: FakeDb) {
  return {
    department: {
      findMany: (args: { select?: Record<string, boolean> }) =>
        Promise.resolve(sortByOrderThenName(state.departments).map((r) => project(r, args.select))),
    },
    section: {
      findUnique: (args: {
        where: { id?: string; departmentId_name?: { departmentId: string; name: string } };
        select?: Record<string, boolean>;
        include?: { department?: unknown };
      }) => {
        const found =
          args.where.id !== undefined
            ? state.sections.find((r) => r.id === args.where.id)
            : state.sections.find(
                (r) =>
                  r.departmentId === args.where.departmentId_name?.departmentId &&
                  r.name === args.where.departmentId_name.name,
              );
        if (found === undefined) {
          return Promise.resolve(null);
        }
        const base = project(found, args.select);
        if (args.include?.department !== undefined) {
          const dept = state.departments.find((d) => d.id === found.departmentId);
          return Promise.resolve({ ...base, department: { name: dept?.name } });
        }
        return Promise.resolve(base);
      },
      findMany: (args: { select?: Record<string, boolean> }) =>
        Promise.resolve(sortByOrderThenName(state.sections).map((r) => project(r, args.select))),
      update: (args: { where: { id: string }; data: { name?: string } }) => {
        const row = state.sections.find((r) => r.id === args.where.id);
        if (row === undefined) {
          return Promise.reject(new Error(`No section ${args.where.id}`));
        }
        if (args.data.name !== undefined) {
          row.name = args.data.name;
        }
        return Promise.resolve({ ...row });
      },
    },
    sectionAlias: {
      findUnique: (args: {
        where: { hrDeptName_hrSectionName: { hrDeptName: string; hrSectionName: string } };
        select?: Record<string, boolean>;
      }) => {
        const key = args.where.hrDeptName_hrSectionName;
        const found = state.aliases.find(
          (a) => a.hrDeptName === key.hrDeptName && a.hrSectionName === key.hrSectionName,
        );
        return Promise.resolve(found === undefined ? null : project(found, args.select));
      },
      create: (args: { data: AliasRow }) => {
        const clash = state.aliases.some(
          (a) =>
            a.hrDeptName === args.data.hrDeptName && a.hrSectionName === args.data.hrSectionName,
        );
        if (clash) {
          // The real unique constraint. If the repo ever creates an alias it should
          // have skipped, this is what surfaces it instead of a silent duplicate.
          return Promise.reject(new Error("Unique constraint failed on sectionAlias"));
        }
        state.aliases.push({ ...args.data, remark: args.data.remark ?? null });
        return Promise.resolve({ ...args.data });
      },
    },
    jobTitleRule: {
      findMany: () => Promise.resolve([]),
    },
    masterDataChangeLog: {
      count: (args: { where: { entity: string } }) =>
        Promise.resolve(state.log.filter((r) => r.entity === args.where.entity).length),
      create: (args: { data: LogRow }) => {
        if (state.log.length >= state.failLogCreateAfter) {
          return Promise.reject(new Error("audit write failed"));
        }
        state.log.push({ ...args.data });
        return Promise.resolve({ ...args.data });
      },
    },
  };
}

beforeEach(() => {
  db = freshDb();
  // restoreMocks only restores spies on real objects - a hoisted bare vi.fn() keeps its
  // call history across tests, which would silently inflate any call-count assertion.
  mocks.$transaction.mockReset();
  mocks.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const staged: FakeDb = structuredClone(db);
    const result = await callback(clientOver(staged));
    // Merged only on success: this is the whole point of the emulator.
    db = staged;
    return result;
  });
});

/** The alias that keeps historical attendance attached, if it was written. */
function aliasFor(hrSectionName: string): AliasRow | undefined {
  return db.aliases.find((a) => a.hrDeptName === DEPT_NAME && a.hrSectionName === hrSectionName);
}

function sectionName(id: string): string | undefined {
  return db.sections.find((r) => r.id === id)?.name;
}

describe("renameSectionWithAlias - the happy path writes both halves", () => {
  it("renames the section and leaves an alias on the old name", async () => {
    const result = await renameSectionWithAlias("sec-kensa", "検査品证课");

    expect(result).toEqual({
      id: "sec-kensa",
      departmentId: "dep-q",
      name: "検査品证课",
      sortOrder: 18,
      managerName: "王某",
      managerEmail: null,
    });
    expect(sectionName("sec-kensa")).toBe("検査品证课");
    // The load-bearing assertion: the OLD spelling now resolves to this same section.
    expect(aliasFor("検査课")).toMatchObject({ sectionId: "sec-kensa" });
  });

  it("records the baseline before the write and the snapshot after it", async () => {
    await renameSectionWithAlias("sec-kensa", "検査品证课");

    // Two rows, in this order: without the baseline the state preceding the first ever
    // edit is unrecoverable, and a baseline taken after the update would store the
    // already-changed state as if it were the original.
    expect(db.log.map((r) => r.action)).toEqual(["baseline", "update"]);
    expect(db.log[0]?.snapshot).toContain("検査课");
    expect(db.log[0]?.snapshot).not.toContain("検査品证课");
    expect(db.log[1]).toMatchObject({ entity: "organization", targetKey: "検査品证课" });
    expect(db.log[1]?.snapshot).toContain("検査品证课");
  });

  it("reuses the existing self-alias instead of creating a duplicate", async () => {
    // The rename-back case: 検査课 -> X -> 検査课 leaves an alias on 検査课 pointing at
    // this very section. Creating a second one would hit the unique constraint, and the
    // real cost of getting this wrong is a rename that fails only on the second attempt.
    db.aliases.push({
      hrDeptName: DEPT_NAME,
      hrSectionName: "検査课",
      sectionId: "sec-kensa",
      remark: "pre-existing",
    });

    await renameSectionWithAlias("sec-kensa", "検査品证课");

    expect(db.aliases).toHaveLength(1);
    expect(aliasFor("検査课")).toMatchObject({ remark: "pre-existing" });
    expect(sectionName("sec-kensa")).toBe("検査品证课");
  });
});

describe("renameSectionWithAlias - name and alias share one transaction", () => {
  it("discards the rename when the audit write fails", async () => {
    // A committed rename without its audit row would be an incomplete trail; a
    // committed rename without its ALIAS silently moves historical hours. Both are
    // ruled out by the same property, and the audit failure is the one a test can
    // trigger without reaching into Prisma.
    db.failLogCreateAfter = 1;

    await expect(renameSectionWithAlias("sec-kensa", "検査品证课")).rejects.toThrow(
      "audit write failed",
    );

    expect(sectionName("sec-kensa")).toBe("検査课");
    expect(db.aliases).toHaveLength(0);
    expect(db.log).toHaveLength(0);
  });

  it("runs every read and write inside a single $transaction call", async () => {
    await renameSectionWithAlias("sec-kensa", "検査品证课");

    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("renameSectionWithAlias - the no-op writes nothing", () => {
  it("returns the section unchanged when the name already matches", async () => {
    const result = await renameSectionWithAlias("sec-kensa", "検査课");

    expect(result.name).toBe("検査课");
    expect(db.aliases).toHaveLength(0);
    // Not even a baseline: an edit that never happened must not appear in the trail,
    // and a baseline row is an assertion that an edit followed it.
    expect(db.log).toHaveLength(0);
  });
});

describe("renameSectionWithAlias - the four refusals write nothing", () => {
  /** Every refusal must leave the store byte-identical, not merely un-renamed. */
  function expectUntouched(): void {
    expect(sectionName("sec-kensa")).toBe("検査课");
    expect(sectionName("sec-hinsho")).toBe("品证课");
    expect(db.log).toHaveLength(0);
  }

  it("refuses an unknown id", async () => {
    await expect(renameSectionWithAlias("sec-missing", "任意名")).rejects.toMatchObject({
      name: "SectionRenameError",
      reason: "not-found",
    });
    expectUntouched();
    expect(db.aliases).toHaveLength(0);
  });

  it("refuses a name another section in the same department already has", async () => {
    const error = await renameSectionWithAlias("sec-kensa", "品证课").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SectionRenameError);
    expect((error as SectionRenameError).reason).toBe("name-taken");
    expectUntouched();
    expect(db.aliases).toHaveLength(0);
  });

  it("refuses when an alias on the OLD name points at a different section", async () => {
    // That alias is a deliberate human mapping. Re-pointing it to keep this rename's
    // own history would move ANOTHER section's historical hours, with nothing on
    // screen to say so - so the refusal is the lesser harm.
    db.aliases.push({
      hrDeptName: DEPT_NAME,
      hrSectionName: "検査课",
      sectionId: "sec-hinsho",
      remark: "homoglyph mapping",
    });

    await expect(renameSectionWithAlias("sec-kensa", "検査品证课")).rejects.toMatchObject({
      reason: "alias-conflict",
    });
    expectUntouched();
    expect(aliasFor("検査课")).toMatchObject({ sectionId: "sec-hinsho" });
  });

  it("refuses a name that is already another section's alias", async () => {
    // The mirror image, and the one that is easy to miss: resolveSectionId() consults
    // the LIVE name index before the alias table, so taking a name an alias already
    // claims would make this section shadow it and absorb the other one's rows.
    db.aliases.push({
      hrDeptName: DEPT_NAME,
      hrSectionName: "検查课",
      sectionId: "sec-hinsho",
      remark: "homoglyph mapping",
    });

    await expect(renameSectionWithAlias("sec-kensa", "検查课")).rejects.toMatchObject({
      reason: "alias-shadow",
    });
    expectUntouched();
    expect(db.aliases).toHaveLength(1);
    expect(aliasFor("検查课")).toMatchObject({ sectionId: "sec-hinsho" });
  });
});
