// D-193 regression guard: deleting a Plan that has audit rows must be REFUSED.
//
// Why this file exists at all. D-193 changed plan_change_log's foreign key from Cascade
// to Restrict so that deleting a Plan can no longer take its own audit trail with it.
// That change was verified once, by hand. Nothing was watching it afterwards: flip the
// relation back to Cascade and every one of the other suites still passes, because none
// of them touches a real database. The failure it re-opens is silent by construction -
// the delete succeeds, the history is gone, and there is no error to notice.
//
// Why this suite uses a real SQLite database while its neighbours mock @/lib/prisma.
// The guarantee under test belongs to the database engine, not to application code.
// A mocked client would only prove that the fake I wrote refuses the delete - a test
// that passes no matter what the real schema says. So this file builds a throwaway
// in-memory database by REPLAYING prisma/migrations/*/migration.sql in order. Replaying
// the migrations rather than hand-writing a CREATE TABLE matters for the same reason:
// a hand-written schema would test my transcription of the constraint, not the shipped
// one.
//
// Cost: a few milliseconds and no fixture files. The migrations are already the source
// of truth for production, so this stays correct as they evolve.

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

// better-sqlite3 ships no type declarations (see the note in src/lib/prisma.ts), so it
// is loaded through createRequire and given the narrow shape this suite actually uses.
// `any` would silence the same error while also silencing real typos in these calls.
interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  pragma(pragma: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

const requireCjs = createRequire(import.meta.url);
const Database = requireCjs("better-sqlite3") as SqliteConstructor;

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

/**
 * Applies every committed migration, in the order Prisma applies them, to `db`.
 *
 * Directory names are timestamp-prefixed, so a lexical sort is the real apply order.
 * Anything without a migration.sql (migration_lock.toml) is skipped.
 */
function applyMigrations(db: SqliteDatabase): void {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  // A zero-migration run would make every assertion below fail for an unrelated reason
  // (no tables), so say the real cause instead.
  if (dirs.length === 0) {
    throw new Error(`No migrations found under ${MIGRATIONS_DIR}`);
  }

  for (const dir of dirs) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
  }
}

/** One department -> one section -> one fiscal year -> one plan, the minimum a Plan needs. */
function seedPlan(db: SqliteDatabase, planId: string, month: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO department (id, name, sortOrder) VALUES ('dep-1', '品质保证部', 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO section (id, departmentId, name, sortOrder)
     VALUES ('sec-1', 'dep-1', '検査课', 18)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO fiscal_year (id, name, year, startDate, endDate, isCurrent)
     VALUES ('fy-2026', 'FY2026', 2026, '2026-04-01 00:00:00', '2027-03-31 00:00:00', 1)`,
  ).run();
  // `month` is a parameter because plan carries @@unique([sectionId, fiscalYearId, month]):
  // two plans under the same section and fiscal year must differ by month or the insert
  // fails on the unique index long before the foreign key is ever exercised.
  db.prepare(
    `INSERT INTO plan (id, sectionId, fiscalYearId, month, plannedHours, challengeHours, updatedAt, updatedBy)
     VALUES (?, 'sec-1', 'fy-2026', ?, 1045, 1100, '2026-08-19 00:00:00', 'admin')`,
  ).run(planId, month);
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

/**
 * Asserts `run` was rejected by the RESTRICT rule, checking the code and not the message.
 *
 * The message is only `FOREIGN KEY constraint failed`, which a UNIQUE or NOT NULL failure
 * would not produce but a *different* foreign key on the same statement would - and
 * `expect().toThrow(/re/)` matches the message, so it cannot tell those apart. The code is
 * SQLITE_CONSTRAINT_TRIGGER rather than _FOREIGNKEY because SQLite implements RESTRICT
 * with trigger semantics; pinning it means an engine or adapter change that downgrades
 * this constraint to a no-op cannot slip through by throwing something else.
 */
function expectRestrictViolation(run: () => void): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught, "the delete was allowed - RESTRICT is not in effect").toBeDefined();
  expect((caught as { code?: string }).code).toBe("SQLITE_CONSTRAINT_TRIGGER");
  expect((caught as Error).message).toMatch(/FOREIGN KEY constraint failed/);
}

let db: SqliteDatabase;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  // The last migration turns foreign keys off to rebuild a table and back on at the end,
  // but assert rather than assume: with the pragma off, RESTRICT is inert and every
  // assertion in this file would pass or fail for reasons that have nothing to do with
  // the constraint.
  expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
});

describe("plan_change_log foreign key (D-193)", () => {
  it("refuses to delete a Plan that has change-log rows", () => {
    seedPlan(db, "plan-1", 1);
    db.prepare(
      `INSERT INTO plan_change_log (id, planId, field, beforeValue, afterValue, reason, changedAt, changedBy)
       VALUES ('log-1', 'plan-1', 'planned_hours', 1000, 1045, '年度调整', '2026-08-19 00:00:00', 'admin')`,
    ).run();

    expectRestrictViolation(() => db.prepare(`DELETE FROM plan WHERE id = 'plan-1'`).run());

    // The point is not just that it threw - it is that nothing was lost.
    expect(countRows(db, "plan")).toBe(1);
    expect(countRows(db, "plan_change_log")).toBe(1);
  });

  it("still deletes a Plan that has no change-log rows", () => {
    // The counter-case. Without it, replacing the FK with a blanket "plans are never
    // deletable" rule would leave the suite green while quietly changing the contract:
    // D-193 restricts plans WITH history, not all plans.
    seedPlan(db, "plan-2", 2);

    db.prepare(`DELETE FROM plan WHERE id = 'plan-2'`).run();

    expect(countRows(db, "plan")).toBe(0);
  });

  it("keeps the audit rows when the delete is rolled back mid-transaction", () => {
    // How a real caller would meet this: a script deleting several plans in one
    // transaction. The rejection must abort the unit rather than commit a partial state.
    seedPlan(db, "plan-3", 3);
    seedPlan(db, "plan-4", 4);
    db.prepare(
      `INSERT INTO plan_change_log (id, planId, field, beforeValue, afterValue, changedAt, changedBy)
       VALUES ('log-2', 'plan-4', 'challenge_hours', 1100, 1200, '2026-08-19 00:00:00', 'admin')`,
    ).run();

    expectRestrictViolation(() => {
      db.exec("BEGIN");
      try {
        db.prepare(`DELETE FROM plan WHERE id = 'plan-3'`).run();
        db.prepare(`DELETE FROM plan WHERE id = 'plan-4'`).run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });

    // plan-3 was deletable on its own, but it must come back: the batch failed.
    expect(countRows(db, "plan")).toBe(2);
    expect(countRows(db, "plan_change_log")).toBe(1);
  });
});

describe("schema.prisma declares the constraint (D-193)", () => {
  it("keeps onDelete: Restrict on PlanChangeLog.plan", () => {
    // The behaviour tests above replay migrations, so they only see a reverted FK once
    // somebody has actually generated the migration for it. This closes the window in
    // between - schema edited, migration not yet run - which is the cheapest moment to
    // catch the mistake.
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const model = /model PlanChangeLog \{([\s\S]*?)\n\}/.exec(schema)?.[1];

    expect(model, "model PlanChangeLog not found in schema.prisma").toBeDefined();
    expect(model).toContain("onDelete: Restrict");
    expect(model).not.toContain("onDelete: Cascade");
  });
});
