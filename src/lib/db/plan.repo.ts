// Row-level read/write access to the `plan` table.
//
// Scope boundary: flat rows only. Cross-section and cross-month sums are
// deliberately NOT computed here - no `groupBy`, no `_sum`, no nested `include`. A
// fiscal year is 288 rows (24 sections x 12 months) under 50KB, so the aggregation
// layer folds them with pure TypeScript: unit-testable without a database, and no
// business rules encoded in SQL that would need rewriting for PostgreSQL.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertNonNegativeHours } from "@/lib/plans/validate";
import { assertFiscalMonth } from "./date";
import { appendPlanChangeLogs, diffPlanChange } from "./plan-change-log.repo";
import type { PlanRow, PlanUpsertInput, PlanWriteResult } from "./types";

/**
 * Shape projected by the reads. Declared locally so the generated Prisma types
 * never surface in this module's exported signatures (see types.ts).
 */
interface PlanRecord {
  sectionId: string;
  fiscalYearId: string;
  month: number;
  plannedHours: number;
  challengeHours: number;
}

const PLAN_ROW_SELECT = {
  sectionId: true,
  fiscalYearId: true,
  month: true,
  plannedHours: true,
  challengeHours: true,
} as const;

/** Maps a database record to the persistence-layer DTO. */
function toPlanRow(record: PlanRecord): PlanRow {
  return {
    sectionId: record.sectionId,
    fiscalYearId: record.fiscalYearId,
    month: record.month,
    plannedHours: record.plannedHours,
    challengeHours: record.challengeHours,
  };
}

/**
 * Validates one input's month and hour quantities.
 *
 * Extracted so single and bulk writes share one definition of "valid", and so the
 * bulk path can run every check BEFORE opening its transaction.
 *
 * Uses assertNonNegativeHours() rather than the bare assertFiniteHours(): the latter
 * passes negative values deliberately, because overtime deductions are legally
 * negative (D-105). That allowance must not extend to plan TARGETS, where a negative
 * is meaningless and would render as a bar below the axis.
 *
 * Deliberately does NOT check `challengeHours <= plannedHours`. D-151 makes
 * FY26工时计划.xlsx the authoritative source for both values and 4 of its 24 sections
 * invert the pair in all 12 months; enforcing the direction here would make the
 * authoritative source unimportable. The inversion is surfaced as a warning by
 * lib/plans/validate.ts#collectChallengeWarnings instead.
 *
 * @throws if `month` is outside 1..12, or either hour value is not a finite number >= 0.
 */
function assertPlanInput(input: PlanUpsertInput): void {
  assertFiscalMonth(input.month);
  assertNonNegativeHours("plannedHours", input.plannedHours);
  assertNonNegativeHours("challengeHours", input.challengeHours);
}

/**
 * Builds the upsert arguments for one input.
 *
 * `where` uses the composite unique key (sectionId, fiscalYearId, month). Upsert
 * rather than create because plan data is re-uploaded from Excel: a repeat run
 * must be idempotent instead of failing on the unique constraint.
 *
 * `updatedBy` is only written when supplied - passing the schema default on every
 * update would erase the identity of the last real editor.
 *
 * Assumes assertPlanInput() has already run.
 */
function planUpsertArgs(input: PlanUpsertInput) {
  const mutable = {
    plannedHours: input.plannedHours,
    challengeHours: input.challengeHours,
    ...(input.updatedBy === undefined ? {} : { updatedBy: input.updatedBy }),
  };
  const key = {
    sectionId: input.sectionId,
    fiscalYearId: input.fiscalYearId,
    month: input.month,
  };
  return {
    where: { sectionId_fiscalYearId_month: key },
    create: { ...key, ...mutable },
    update: mutable,
    select: { id: true },
  };
}

/**
 * All plan rows for a fiscal year, ordered by (sectionId, month). The org-tree
 * adapter indexes by key and does not need this, but a stable order makes
 * fixtures, snapshots and manual diffs reproducible.
 */
export async function findPlansByFiscalYear(
  fiscalYearId: string,
): Promise<PlanRow[]> {
  const records = await prisma.plan.findMany({
    where: { fiscalYearId },
    select: PLAN_ROW_SELECT,
    orderBy: [{ sectionId: "asc" }, { month: "asc" }],
  });
  return records.map(toPlanRow);
}

/** The 12 plan rows of one section within one fiscal year, ordered by month. */
export async function findPlansBySection(
  sectionId: string,
  fiscalYearId: string,
): Promise<PlanRow[]> {
  const records = await prisma.plan.findMany({
    where: { sectionId, fiscalYearId },
    select: PLAN_ROW_SELECT,
    orderBy: { month: "asc" },
  });
  return records.map(toPlanRow);
}

/**
 * Inserts or updates one plan row.
 *
 * @throws if `month` is outside 1..12. Not optional defensiveness: an out-of-range
 *   month reaches buildOrgRoot(), which writes `months[month - 1]` - JS silently
 *   extends or drops the slot, so the dashboard shows wrong totals with no error.
 * @throws if either hour value is not a finite number >= 0 - see hours.ts for why
 *   NOT NULL does not catch non-finite values.
 */
export async function upsertPlan(input: PlanUpsertInput): Promise<void> {
  assertPlanInput(input);
  await prisma.plan.upsert(planUpsertArgs(input));
}

/**
 * All-or-nothing bulk write. Returns the number of rows written.
 *
 * Every input is validated BEFORE the transaction opens. Validating inside the
 * loop would make the failure point depend on input order and would pay for a
 * partial write that then rolls back.
 *
 * Uses an upsert loop, not `createMany`: SQLite's `createMany` has no
 * `skipDuplicates`, and re-running the seed or re-uploading a spreadsheet must not
 * raise a unique-constraint error. 288 upserts in one transaction complete in well
 * under a second, so the loop costs nothing worth optimising.
 *
 * @throws if any input has a `month` outside 1..12 or an hour value that is not a
 *   finite number >= 0 - nothing is written.
 */
export async function upsertPlansBulk(
  inputs: readonly PlanUpsertInput[],
): Promise<number> {
  for (const input of inputs) {
    assertPlanInput(input);
  }
  if (inputs.length === 0) {
    return 0;
  }
  await prisma.$transaction(async (tx) => {
    for (const input of inputs) {
      await tx.plan.upsert(planUpsertArgs(input));
    }
  });
  return inputs.length;
}

/**
 * Row count for a fiscal year. A complete year is 288 rows; fewer means the import
 * was partial and the dashboard would render gaps.
 */
export async function countPlansByFiscalYear(
  fiscalYearId: string,
): Promise<number> {
  return prisma.plan.count({ where: { fiscalYearId } });
}

/**
 * Writes one plan row and its audit entries inside a CALLER-SUPPLIED transaction.
 *
 * Extracted from upsertPlanWithAudit() so the bulk import can reuse the exact
 * read-diff-write-append sequence. It could not simply call that function in a loop:
 * upsertPlanWithAudit() opens its own `prisma.$transaction`, and 288 nested
 * transactions would neither nest nor stay atomic - a failure at row 200 would leave
 * 199 committed. Taking `tx` as a parameter puts the choice of transaction boundary
 * with the caller, which is the only place that knows how many rows must succeed
 * together.
 *
 * Assumes `assertPlanInput(input)` has ALREADY run. Validation is the caller's job
 * because the bulk path must validate all 288 rows before opening its transaction -
 * validating here would make the failure point depend on row order and would pay for
 * a partial write that then rolls back.
 */
async function upsertPlanWithAuditTx(
  tx: Prisma.TransactionClient,
  input: PlanUpsertInput & { changedBy: string; reason?: string | null },
): Promise<PlanWriteResult> {
  const key = {
    sectionId: input.sectionId,
    fiscalYearId: input.fiscalYearId,
    month: input.month,
  };

  const existing = await tx.plan.findUnique({
    where: { sectionId_fiscalYearId_month: key },
    select: { id: true, plannedHours: true, challengeHours: true },
  });

  const written = await tx.plan.upsert(
    // updatedBy carries the editor's identity onto the row itself, so the current
    // state names its last author without a join back to the log.
    planUpsertArgs({ ...input, updatedBy: input.changedBy }),
  );

  if (existing === null) {
    return { planId: written.id, created: true, loggedChanges: 0 };
  }

  const entries = diffPlanChange(
    existing.id,
    existing,
    { plannedHours: input.plannedHours, challengeHours: input.challengeHours },
    input.changedBy,
    input.reason,
  );
  const loggedChanges = await appendPlanChangeLogs(tx, entries);
  return { planId: existing.id, created: false, loggedChanges };
}

/**
 * Writes one plan row AND its audit trail atomically (D-143).
 *
 * This is the write path for the admin edit grid and for audited imports;
 * `upsertPlan()` / `upsertPlansBulk()` remain the paths for seeding, where there is no
 * prior value to have changed from.
 *
 * The sequence - read stored values, diff, write, append - runs inside ONE
 * transaction, and the ordering matters in both directions:
 *
 *   * The read must be inside it, or a concurrent edit lands between read and write
 *     and the trail records a `beforeValue` that was never overwritten by this
 *     caller. Two admins were assumed (D-142), so this is a real interleaving, not
 *     a theoretical one.
 *   * The append must be inside it, or a failure to record leaves an unattributable
 *     change in the plan table. Given the choice between "the number changed and
 *     nobody knows why" and "the edit was refused", D-143 picks the refusal.
 *
 * A first insert logs nothing: `created: true` with `loggedChanges: 0`. There is no
 * prior value, so a synthetic 0 -> 1045 entry would misreport an import as an edit.
 *
 * @param reason - optional justification, applied to every entry this edit produces.
 * @throws if `month` is outside 1..12, or either hour value is not a finite number
 *   >= 0, or `changedBy` is blank - in every case nothing is written.
 */
export async function upsertPlanWithAudit(
  input: PlanUpsertInput & { changedBy: string; reason?: string | null },
): Promise<PlanWriteResult> {
  assertPlanInput(input);
  return prisma.$transaction((tx) => upsertPlanWithAuditTx(tx, input));
}

/** Aggregate outcome of an audited bulk write. */
export interface BulkPlanWriteResult {
  /** Rows written (inserted + updated). Equals the input length on success. */
  rowsWritten: number;
  /** Rows that did not previously exist. */
  created: number;
  /** Rows that already existed and were overwritten. */
  updated: number;
  /**
   * Audit entries appended. NOT `rowsWritten * 2` - only genuinely changed values are
   * logged, so re-importing an unmodified spreadsheet appends 0.
   */
  loggedChanges: number;
}

/**
 * All-or-nothing bulk write WITH an audit trail (D-143), for the Excel import.
 *
 * Why the import needs this rather than `upsertPlansBulk()`: that function's docblock
 * assigns imports to the unaudited path on the grounds that an import has "no prior
 * value to have changed from". True for the FIRST import of a fiscal year - and false
 * for a re-import over an existing one, where every differing cell is a real change to
 * a number someone may already have approved. D-143 requires all modifications to be
 * traceable, and it does not exempt those arriving by spreadsheet.
 *
 * Logs only what actually differs, so the trail stays readable: correcting one cell
 * and re-uploading appends 1 entry, not 288. The whole set commits or none of it does,
 * so a failure at row 200 cannot leave the year half-overwritten - a state in which the
 * dashboard would mix two plan versions with no indication it was doing so.
 *
 * @param inputs typically 288 rows (24 sections x 12 months) for one fiscal year.
 * @param changedBy audit attribution, applied to every entry.
 * @param reason optional justification, applied to every entry.
 * @throws if any input is invalid or `changedBy` is blank - nothing is written.
 */
export async function upsertPlansBulkWithAudit(
  inputs: readonly PlanUpsertInput[],
  changedBy: string,
  reason?: string | null,
): Promise<BulkPlanWriteResult> {
  // Validate EVERYTHING before opening the transaction - see upsertPlansBulk().
  for (const input of inputs) {
    assertPlanInput(input);
  }
  if (inputs.length === 0) {
    return { rowsWritten: 0, created: 0, updated: 0, loggedChanges: 0 };
  }

  return prisma.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let loggedChanges = 0;
    for (const input of inputs) {
      const result = await upsertPlanWithAuditTx(tx, {
        ...input,
        changedBy,
        reason,
      });
      if (result.created) {
        created += 1;
      } else {
        updated += 1;
      }
      loggedChanges += result.loggedChanges;
    }
    return { rowsWritten: inputs.length, created, updated, loggedChanges };
  });
}
