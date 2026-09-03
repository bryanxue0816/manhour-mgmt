// D-173 acceptance: the master-data snapshot trail.
//
// `master-data-change-log.repo.ts` imports `@/lib/prisma`, which builds a
// better-sqlite3 PrismaClient at module load time, so this suite mocks that module -
// same reason `import-status.test.ts` exists as its own file: a unit test must not
// need a database to check logic.
//
// The fake below is a transaction emulator, not a database. It stages a deep copy of
// the state, hands the repo a client backed by that copy, and only merges it back if
// the callback resolves. That makes the composition testable - whether the business
// write and its snapshot really share one atomic unit, and whether a failing snapshot
// discards the write - WITHOUT claiming to prove SQLite's rollback, which is Prisma's
// job and is checked separately against the real database.
//
// What each fake delegate does implement faithfully is `select` projection and
// `orderBy`, because both are part of the stored snapshot format: the projection is
// what keeps `updatedAt` out of the payload (a timestamp moving on every write would
// make two snapshots of identical business state compare as different), and the
// ordering is what keeps a diff between two snapshots free of row-order churn.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

// Hoisted above the import below by Vitest, so the repo never builds a real client.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.$transaction,
    masterDataChangeLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import {
  MASTER_DATA_ALL_TARGETS,
  type MasterDataAction,
  type MasterDataEntity,
  ensureMasterDataBaseline,
  recordMasterDataSnapshot,
  writeMasterDataWithAudit,
} from "@/lib/db/master-data-change-log.repo";
import { REASON_MAX_LENGTH } from "@/lib/db/reason";

// --------------------------------------------------------------------------------
// Fake store
// --------------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDb {
  departments: Row[];
  sections: Row[];
  rules: Row[];
  log: Row[];
  /** Throws from `masterDataChangeLog.create` once this many rows exist. */
  failCreateAfter: number;
}

/** Builds a comparator from a Prisma `orderBy` argument, so ordering is really tested. */
function compareBy(orderBy: unknown): (a: Row, b: Row) => number {
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return (a, b) => {
    for (const term of terms) {
      const entry = Object.entries(term)[0];
      if (entry === undefined) continue;
      const [field, direction] = entry;
      const left = a[field] as string | number;
      const right = b[field] as string | number;
      if (left === right) continue;
      const cmp = left < right ? -1 : 1;
      return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  };
}

function project(row: Row, select: Row): Row {
  const out: Row = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted === true) out[field] = row[field];
  }
  return out;
}

function findMany(rows: Row[], args: { select: Row; orderBy: unknown }): Row[] {
  return [...rows].sort(compareBy(args.orderBy)).map((row) => project(row, args.select));
}

function makeTx(state: FakeDb): Prisma.TransactionClient {
  const tx = {
    department: {
      findMany: async (args: { select: Row; orderBy: unknown }) =>
        findMany(state.departments, args),
    },
    section: {
      findMany: async (args: { select: Row; orderBy: unknown }) => findMany(state.sections, args),
      update: async (args: { where: { id: string }; data: Row }) => {
        const row = state.sections.find((candidate) => candidate.id === args.where.id);
        if (row === undefined) throw new Error(`No section ${args.where.id}`);
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    jobTitleRule: {
      findMany: async (args: { select: Row; orderBy: unknown }) => findMany(state.rules, args),
    },
    masterDataChangeLog: {
      count: async (args: { where: { entity: string } }) =>
        state.log.filter((row) => row.entity === args.where.entity).length,
      create: async (args: { data: Row }) => {
        if (state.log.length >= state.failCreateAfter) {
          throw new Error("simulated audit write failure");
        }
        // Fixed timestamps, not Date.now(): two rows written in the same millisecond
        // would otherwise make an ordering assertion flaky.
        const row = {
          id: `log-${state.log.length + 1}`,
          changedAt: new Date(Date.UTC(2026, 7, 13, 0, state.log.length)),
          changedBy: "admin",
          ...args.data,
        };
        state.log.push(row);
        return { ...row };
      },
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

/** Commit-or-discard around the repo's transaction callback. */
async function runInTransaction<T>(
  db: FakeDb,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const staged = structuredClone(db);
  const result = await callback(makeTx(staged));
  Object.assign(db, staged);
  return result;
}

function makeDb(): FakeDb {
  return {
    departments: [
      // Deliberately out of order, and carrying two columns the snapshot must drop.
      {
        id: "d2",
        name: "品质保证部",
        code: null,
        sortOrder: 2,
        managerName: null,
        managerEmail: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: "d1",
        name: "经营企画部",
        code: null,
        sortOrder: 1,
        managerName: "山田",
        managerEmail: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    sections: [
      {
        id: "s1",
        departmentId: "d2",
        name: "検査课",
        sortOrder: 20,
        managerName: null,
        managerEmail: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: "s2",
        departmentId: "d1",
        name: "企画课",
        sortOrder: 10,
        managerName: null,
        managerEmail: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    rules: [
      {
        jobTitle: "工场长",
        excludePersonnelHours: false,
        excludeOvertimeHours: true,
        remark: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        jobTitle: "高级课长",
        excludePersonnelHours: false,
        excludeOvertimeHours: true,
        remark: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    log: [],
    failCreateAfter: Number.POSITIVE_INFINITY,
  };
}

let db: FakeDb;

beforeEach(() => {
  db = makeDb();
  mocks.$transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    runInTransaction(db, callback),
  );
});

// --------------------------------------------------------------------------------

describe("ensureMasterDataBaseline", () => {
  it("writes the baseline once and reports that it did", async () => {
    const wrote = await runInTransaction(db, (tx) => ensureMasterDataBaseline(tx, "organization"));

    expect(wrote).toBe(true);
    expect(db.log).toHaveLength(1);
    expect(db.log[0]).toMatchObject({
      entity: "organization",
      action: "baseline",
      targetKey: MASTER_DATA_ALL_TARGETS,
    });
  });

  it("does not write a second baseline once the trail has any row", async () => {
    await runInTransaction(db, (tx) => ensureMasterDataBaseline(tx, "organization"));
    await runInTransaction(db, (tx) =>
      recordMasterDataSnapshot(tx, { entity: "organization", action: "update", targetKey: "検査课" }),
    );

    const wrote = await runInTransaction(db, (tx) => ensureMasterDataBaseline(tx, "organization"));

    expect(wrote).toBe(false);
    expect(db.log.filter((row) => row.action === "baseline")).toHaveLength(1);
    expect(db.log).toHaveLength(2);
  });

  it("keeps the two entity classes independent - one baseline each", async () => {
    // The emptiness check is scoped by entity. If it were not, the first org edit would
    // suppress the rule baseline and the pre-edit rule state would be lost for good.
    await runInTransaction(db, (tx) => ensureMasterDataBaseline(tx, "organization"));
    const wroteRules = await runInTransaction(db, (tx) =>
      ensureMasterDataBaseline(tx, "job_title_rule"),
    );

    expect(wroteRules).toBe(true);
    expect(db.log.map((row) => [row.entity, row.action])).toEqual([
      ["organization", "baseline"],
      ["job_title_rule", "baseline"],
    ]);
  });

  it("rejects an entity outside the declared set", async () => {
    await expect(
      runInTransaction(db, (tx) =>
        ensureMasterDataBaseline(tx, "section" as unknown as MasterDataEntity),
      ),
    ).rejects.toThrow(/Invalid master data entity/);
    expect(db.log).toHaveLength(0);
  });
});

describe("recordMasterDataSnapshot", () => {
  it("stores the organisation snapshot as JSON that parses back to the source rows", async () => {
    await runInTransaction(db, (tx) =>
      recordMasterDataSnapshot(tx, { entity: "organization", action: "update", targetKey: "検査课" }),
    );

    const snapshot = JSON.parse(String(db.log[0]?.snapshot)) as {
      departments: Row[];
      sections: Row[];
    };

    expect(snapshot.departments).toEqual([
      { id: "d1", name: "经营企画部", code: null, sortOrder: 1, managerName: "山田", managerEmail: null },
      { id: "d2", name: "品质保证部", code: null, sortOrder: 2, managerName: null, managerEmail: null },
    ]);
    expect(snapshot.sections).toEqual([
      { id: "s2", departmentId: "d1", name: "企画课", sortOrder: 10, managerName: null, managerEmail: null },
      { id: "s1", departmentId: "d2", name: "検査课", sortOrder: 20, managerName: null, managerEmail: null },
    ]);
  });

  it("excludes createdAt / updatedAt from the payload", async () => {
    await runInTransaction(db, (tx) =>
      recordMasterDataSnapshot(tx, { entity: "organization", action: "update", targetKey: "検査课" }),
    );

    const raw = String(db.log[0]?.snapshot);
    expect(raw).not.toContain("createdAt");
    expect(raw).not.toContain("updatedAt");
  });

  it("writes only the rules into a job_title_rule snapshot, never the org tree", async () => {
    await runInTransaction(db, (tx) =>
      recordMasterDataSnapshot(tx, {
        entity: "job_title_rule",
        action: "update",
        targetKey: MASTER_DATA_ALL_TARGETS,
      }),
    );

    const snapshot = JSON.parse(String(db.log[0]?.snapshot)) as Record<string, unknown>;

    expect(Object.keys(snapshot)).toEqual(["rules"]);
    expect(snapshot.rules).toEqual([
      { jobTitle: "工场长", excludePersonnelHours: false, excludeOvertimeHours: true, remark: null },
      { jobTitle: "高级课长", excludePersonnelHours: false, excludeOvertimeHours: true, remark: null },
    ]);
  });

  it("rejects an action outside the declared set", async () => {
    await expect(
      runInTransaction(db, (tx) =>
        recordMasterDataSnapshot(tx, {
          entity: "organization",
          action: "delete" as unknown as MasterDataAction,
          targetKey: "検査课",
        }),
      ),
    ).rejects.toThrow(/Invalid master data action/);
  });

  it("rejects a blank target key - a snapshot must say what was edited", async () => {
    await expect(
      runInTransaction(db, (tx) =>
        recordMasterDataSnapshot(tx, { entity: "organization", action: "update", targetKey: "  " }),
      ),
    ).rejects.toThrow(/targetKey is required/);
  });
});

describe("recordMasterDataSnapshot - the optional reason (D-184)", () => {
  /** One snapshot row with `reason` set to whatever the caller passed. */
  async function record(reason?: string | null): Promise<Row | undefined> {
    await runInTransaction(db, (tx) =>
      recordMasterDataSnapshot(tx, {
        entity: "organization",
        action: "update",
        targetKey: "検査课",
        reason,
      }),
    );
    return db.log[0];
  }

  it("stores a trimmed reason", async () => {
    const row = await record("  组织调整 2026H2  ");

    expect(row?.reason).toBe("组织调整 2026H2");
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("stores null when the reason is %s", async (_label, reason) => {
    // Second half of the contract normaliseReason exists for: if "" were stored, then
    // `reason IS NOT NULL` would stop meaning "this change came with an explanation".
    const row = await record(reason);

    expect(row?.reason).toBeNull();
  });

  it("accepts a reason at exactly the length limit", async () => {
    const atLimit = "由".repeat(REASON_MAX_LENGTH);

    const row = await record(atLimit);

    expect(row?.reason).toBe(atLimit);
  });

  it("refuses an over-long reason instead of truncating it", async () => {
    // The column is a plain String with no database-level limit, so this guard is the
    // only thing standing between a non-UI caller and an unbounded write. Refusing
    // rather than truncating: a half-sentence in an audit trail is worse than none.
    await expect(record("由".repeat(REASON_MAX_LENGTH + 1))).rejects.toThrow(
      /reason exceeds 200 characters/,
    );
    expect(db.log).toHaveLength(0);
  });
});

describe("writeMasterDataWithAudit", () => {
  it("commits the write, its baseline and its snapshot as one unit", async () => {
    const written = await writeMasterDataWithAudit(
      "organization",
      async (tx) => tx.section.update({ where: { id: "s1" }, data: { sortOrder: 99 } }),
      (row) => ({ action: "update", targetKey: String(row.name) }),
    );

    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(written.sortOrder).toBe(99);
    expect(db.sections.find((row) => row.id === "s1")?.sortOrder).toBe(99);
    expect(db.log.map((row) => row.action)).toEqual(["baseline", "update"]);

    // The baseline holds the PRE-edit value and the snapshot the post-edit one. This is
    // the whole point of ensureMasterDataBaseline() running before the write.
    const baseline = JSON.parse(String(db.log[0]?.snapshot)) as { sections: Row[] };
    const after = JSON.parse(String(db.log[1]?.snapshot)) as { sections: Row[] };
    expect(baseline.sections.find((row) => row.id === "s1")?.sortOrder).toBe(20);
    expect(after.sections.find((row) => row.id === "s1")?.sortOrder).toBe(99);
  });

  it("discards the business write when the audit row fails", async () => {
    // Baseline succeeds, the post-write snapshot does not - the case that would
    // otherwise leave a committed edit with no trail, which is what D-173 forbids.
    db.failCreateAfter = 1;

    await expect(
      writeMasterDataWithAudit(
        "organization",
        async (tx) => tx.section.update({ where: { id: "s1" }, data: { sortOrder: 99 } }),
        (row) => ({ action: "update", targetKey: String(row.name) }),
      ),
    ).rejects.toThrow(/simulated audit write failure/);

    expect(db.sections.find((row) => row.id === "s1")?.sortOrder).toBe(20);
    expect(db.log).toHaveLength(0);
  });

  it("writes no snapshot when the business write itself fails", async () => {
    await expect(
      writeMasterDataWithAudit(
        "organization",
        async (tx) => tx.section.update({ where: { id: "missing" }, data: { sortOrder: 1 } }),
        (row) => ({ action: "update", targetKey: String(row.name) }),
      ),
    ).rejects.toThrow(/No section missing/);

    // Not even the baseline survives: a trail that records a rejected edit is as
    // misleading as one that misses a successful edit.
    expect(db.log).toHaveLength(0);
  });

  it("puts the reason on the snapshot only, never on the baseline (D-184)", async () => {
    await writeMasterDataWithAudit(
      "organization",
      async (tx) => tx.section.update({ where: { id: "s1" }, data: { sortOrder: 99 } }),
      (row) => ({ action: "update", targetKey: String(row.name), reason: "组织调整" }),
    );

    // The baseline describes the state before anybody had a chance to explain anything,
    // so attaching this edit's reason to it would credit an earlier state with a
    // justification that was written for a later one.
    expect(db.log.map((row) => [row.action, row.reason])).toEqual([
      ["baseline", null],
      ["update", "组织调整"],
    ]);
  });

  it("stores null when the describe callback returns no reason", async () => {
    await writeMasterDataWithAudit(
      "organization",
      async (tx) => tx.section.update({ where: { id: "s1" }, data: { sortOrder: 99 } }),
      (row) => ({ action: "update", targetKey: String(row.name) }),
    );

    expect(db.log.map((row) => row.reason)).toEqual([null, null]);
  });
});
