// D-174, one layer below the Server Actions: the audited write path itself.
//
// `upsertPlanWithAudit` / `upsertPlansBulkWithAudit` now take `reason: string` rather
// than `reason?: string | null`. The type stops the mistake at compile time for callers
// inside this repository; the runtime guard is what covers a value that only becomes
// blank at runtime - a trimmed form field, a JSON body, a future script. This suite
// pins the guard, and pins that it fires BEFORE any row is written.
//
// `@/lib/prisma` is mocked so no database is needed. The fake `$transaction` just runs
// the callback with a client whose delegates all throw: reaching one of them means the
// guard let an unexplained write through, and the test fails with a clear reason.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.$transaction },
}));

import { upsertPlanWithAudit, upsertPlansBulkWithAudit } from "@/lib/db/plan.repo";

/** Runs the callback with a client that fails loudly on any actual query. */
function runTransaction(): void {
  mocks.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => {
    const explode = (): never => {
      throw new Error("A query ran despite a blank reason - the D-174 guard did not fire.");
    };
    return Promise.resolve(
      callback({
        plan: { findUnique: explode, upsert: explode },
        planChangeLog: { create: explode, createMany: explode },
      }),
    );
  });
}

const input = {
  sectionId: "sec-1",
  fiscalYearId: "fy-2026",
  month: 1,
  plannedHours: 1045,
  challengeHours: 1100,
} as const;

// `restoreMocks` restores spies, but a bare vi.fn() keeps its call history across tests,
// and one test below asserts the transaction was NEVER opened.
beforeEach(() => {
  mocks.$transaction.mockReset();
});

describe("upsertPlanWithAudit - blank reason is refused", () => {
  it("throws on an empty reason", async () => {
    runTransaction();

    await expect(
      upsertPlanWithAudit({ ...input, changedBy: "admin", reason: "" }),
    ).rejects.toThrow(/reason is required/);
  });

  it("throws on a whitespace-only reason", async () => {
    runTransaction();

    await expect(
      upsertPlanWithAudit({ ...input, changedBy: "admin", reason: " \n " }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe("upsertPlansBulkWithAudit - blank reason is refused", () => {
  it("throws on a blank reason before opening a transaction", async () => {
    runTransaction();

    await expect(
      upsertPlansBulkWithAudit([input], "admin", "   "),
    ).rejects.toThrow(/reason is required/);
  });

  it("still short-circuits an empty input list", async () => {
    // Order matters: zero rows is not a failure, and the guard must not turn the
    // no-op path into an error just because the caller had nothing to justify.
    const result = await upsertPlansBulkWithAudit([], "admin", "");

    expect(result).toEqual({ rowsWritten: 0, created: 0, updated: 0, loggedChanges: 0 });
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});
