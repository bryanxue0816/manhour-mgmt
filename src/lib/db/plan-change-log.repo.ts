// Append-only audit trail for plan edits (D-143).
//
// D-143 permits an admin to adjust a plan target mid-year, on the condition that
// the change is recorded: who, when, from what, to what, and optionally why. This
// module is the only writer of `plan_change_log`.
//
// Two deliberate constraints shape the API:
//
//   * `appendPlanChangeLogs()` REQUIRES a transaction client. It does not accept
//     the global `prisma`, and there is no convenience overload that opens its own
//     transaction. The trail is worthless if the numeric write can succeed while
//     the entry recording it fails, so the type system refuses to let a caller
//     write one without the other. `upsertPlanWithAudit()` in plan.repo.ts is the
//     intended composition point.
//   * There is no update and no delete. An audit trail that can be rewritten is
//     not an audit trail; corrections are expressed as a further change entry.

import type { Prisma, PlanChangeLog } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertFiniteHours } from "./hours";
import type { PlanChangeField, PlanChangeLogInput } from "./types";

/** Read shape. Declared here so the generated Prisma row type stays internal. */
export interface PlanChangeLogDto {
  id: string;
  planId: string;
  field: PlanChangeField;
  beforeValue: number;
  afterValue: number;
  reason: string | null;
  changedAt: Date;
  changedBy: string;
}

/**
 * The two legal values of `plan_change_log.field`.
 *
 * `field` is a plain String column - Prisma has no enum on SQLite - so the union in
 * types.ts is compile-time only. This set is the runtime half, checked on write so
 * a value cast through `as` or arriving from a form body cannot widen the column.
 */
const PLAN_CHANGE_FIELDS: ReadonlySet<string> = new Set<PlanChangeField>([
  "planned_hours",
  "challenge_hours",
]);

/**
 * Maps a Prisma row to the DTO.
 *
 * `field` is narrowed by assertion rather than validated: every row was written
 * through appendPlanChangeLogs(), which rejects anything outside the set above.
 * Re-checking on read would only catch rows inserted by raw SQL, and failing a
 * read is the wrong response to that - the audit trail should still be readable.
 */
function toPlanChangeLogDto(row: PlanChangeLog): PlanChangeLogDto {
  return {
    id: row.id,
    planId: row.planId,
    field: row.field as PlanChangeField,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    reason: row.reason,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
  };
}

/**
 * Collapses a blank reason to null.
 *
 * `reason` is optional (D-143), and "" / "   " mean the same thing as omitting it.
 * Storing the empty string instead would make `reason IS NOT NULL` a useless
 * filter for "changes that came with an explanation".
 */
function normaliseReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) {
    return null;
  }
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates one entry before it is written.
 *
 * `beforeValue` and `afterValue` go through assertFiniteHours() rather than the
 * stricter assertNonNegativeHours(): the log records history, including a bad value
 * being corrected. Refusing to record where a row came from would be the wrong
 * trade - the guard against writing a bad value lives on the plan write itself.
 *
 * @throws if `field` is not one of the two legal column values, if `changedBy` is
 *   blank, or if either value is not a finite number.
 */
function assertPlanChangeLogInput(input: PlanChangeLogInput): void {
  if (!PLAN_CHANGE_FIELDS.has(input.field)) {
    throw new Error(
      `Invalid plan change field: ${JSON.stringify(input.field)} ` +
        "(expected 'planned_hours' or 'challenge_hours').",
    );
  }
  if (input.changedBy.trim() === "") {
    throw new Error(
      "Invalid plan change log: changedBy is required. An audit entry with no " +
        "author cannot answer the question the trail exists to answer (D-143).",
    );
  }
  assertFiniteHours(`${input.field}.beforeValue`, input.beforeValue);
  assertFiniteHours(`${input.field}.afterValue`, input.afterValue);
}

/**
 * Appends audit entries inside a caller-owned transaction. Returns the count.
 *
 * @param tx - transaction client from the SAME `$transaction` as the plan write
 *   being recorded. Passing the global `prisma` is a type error, and that is the
 *   point: an entry committed independently of the value it describes can outlive a
 *   rolled-back write, or be lost when the write succeeds.
 *
 * @throws if any entry is invalid - nothing is appended, and because `tx` is shared
 *   the enclosing plan write rolls back with it.
 */
export async function appendPlanChangeLogs(
  tx: Prisma.TransactionClient,
  inputs: readonly PlanChangeLogInput[],
): Promise<number> {
  for (const input of inputs) {
    assertPlanChangeLogInput(input);
  }
  if (inputs.length === 0) {
    return 0;
  }
  // createMany is safe here where it is not for plans: the table has no unique
  // constraint to collide with, so there is no skipDuplicates gap to work around.
  await tx.planChangeLog.createMany({
    data: inputs.map((input) => ({
      planId: input.planId,
      field: input.field,
      beforeValue: input.beforeValue,
      afterValue: input.afterValue,
      reason: normaliseReason(input.reason),
      changedBy: input.changedBy,
    })),
  });
  return inputs.length;
}

/**
 * Derives the audit entries for one edit by comparing stored values to submitted
 * ones. Returns an empty array when nothing moved.
 *
 * Comparing before appending is what keeps the trail signal rather than noise: the
 * edit grid submits a whole cell (both quantities) on blur, so a user who retypes
 * the same number, or changes only the challenge target, would otherwise generate
 * entries recording that nothing happened.
 *
 * Strict `!==` on Float columns is correct here and not a floating-point hazard.
 * The comparison is between a value read back from SQLite and a value the operator
 * typed, both parsed to the nearest double - equal inputs produce bit-identical
 * doubles. No arithmetic happens in between, so there is no accumulated error for
 * an epsilon to absorb.
 */
export function diffPlanChange(
  planId: string,
  before: { plannedHours: number; challengeHours: number },
  after: { plannedHours: number; challengeHours: number },
  changedBy: string,
  reason?: string | null,
): PlanChangeLogInput[] {
  const entries: PlanChangeLogInput[] = [];
  if (before.plannedHours !== after.plannedHours) {
    entries.push({
      planId,
      field: "planned_hours",
      beforeValue: before.plannedHours,
      afterValue: after.plannedHours,
      reason,
      changedBy,
    });
  }
  if (before.challengeHours !== after.challengeHours) {
    entries.push({
      planId,
      field: "challenge_hours",
      beforeValue: before.challengeHours,
      afterValue: after.challengeHours,
      reason,
      changedBy,
    });
  }
  return entries;
}

/**
 * Audit entries for one plan row, newest first.
 *
 * @param limit - caps the result. A single cell edited repeatedly during a review
 *   session can accumulate dozens of entries, and the UI shows a recent-history
 *   popover, not the full trail.
 */
export async function findPlanChangeLogs(
  planId: string,
  limit = 50,
): Promise<PlanChangeLogDto[]> {
  const rows = await prisma.planChangeLog.findMany({
    where: { planId },
    orderBy: { changedAt: "desc" },
    take: limit,
  });
  return rows.map(toPlanChangeLogDto);
}

/** Total audit entries for a fiscal year - drives the "N 次修改" admin counter. */
export async function countPlanChangeLogsByFiscalYear(
  fiscalYearId: string,
): Promise<number> {
  return prisma.planChangeLog.count({ where: { plan: { fiscalYearId } } });
}
