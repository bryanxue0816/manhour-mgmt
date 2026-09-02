// Row-level read/write access to the `actual_adjustment` table (D-233).
//
// Scope boundary matches actual.repo.ts and plan.repo.ts: flat rows only, no `groupBy` /
// `_sum` / nested `include`. The summing lives in actual-merge.ts, where it is testable
// without a database and portable to PostgreSQL.
//
// WHY THERE IS NO `upsert` HERE, unlike every sibling repo. Adjustment slips are
// APPEND-ONLY. Correcting one is revoke-then-insert, never an in-place edit of `hours`.
// The operator explicitly chose to have no approval step (D-233), which means the audit
// trail is the ONLY control on this table - and an upsert that overwrote `hours` would
// leave no trace of the original figure, turning a slip back into exactly the untraceable
// hand-edit this table was built to replace. `Actual` has no audit table of its own, so
// there is no second place the old value could survive.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertFiscalMonth } from "./date";
import { assertFiniteHours } from "./hours";
import type { ActualAdjustmentInput, ActualAdjustmentRow } from "./types";

/** Fixed actor. A placeholder for provenance, never evidence of who acted (D-142). */
const ADJUSTMENT_ACTOR = "admin";

const ADJUSTMENT_ROW_SELECT = {
  id: true,
  sectionId: true,
  fiscalYearId: true,
  month: true,
  hours: true,
  reason: true,
  foldHoursAtEntry: true,
  changedBy: true,
  changedAt: true,
  revokedAt: true,
  revokedBy: true,
} as const;

/**
 * Validates one slip before it reaches the database.
 *
 * @throws if `month` is outside 1..12. Same reason as actual.repo.ts: an out-of-range
 *   month reaches buildOrgRoot(), which writes `months[month - 1]` and silently extends
 *   or drops the slot.
 * @throws if `hours` is not finite - Infinity persists and poisons every roll-up that
 *   sums it (see hours.ts for the measured chain).
 * @throws if `hours` is 0. Not pedantry: a zero slip changes no total, yet it still makes
 *   adjustedMonths() report that month as adjusted, so the screen would caption a
 *   footnote about hours nobody adjusted. There is no operation a zero slip expresses -
 *   withdrawing an adjustment is a revoke.
 * @throws if `reason` is blank. MANDATORY here, unlike MasterDataChangeLog.reason: with
 *   no approval gate the reason is the entire explanation of why a number disagrees with
 *   its detail, and a whitespace-only string satisfies NOT NULL while explaining nothing.
 */
function assertAdjustmentInput(input: ActualAdjustmentInput): void {
  assertFiscalMonth(input.month);
  assertFiniteHours("hours", input.hours);
  if (input.hours === 0) {
    throw new Error(
      "调整工时不能为 0：零调整不改变任何合计，却会让该月被标注为「已调整」。" +
        "如需撤回某张调整单，请使用撤销功能。",
    );
  }
  if (input.reason.trim() === "") {
    throw new Error(
      "调整理由为必填：系统未设审批环节，理由是该笔差异唯一的说明来源。",
    );
  }
}

/** Maps a database record to the persistence-layer DTO. */
function toAdjustmentRow(record: {
  id: string;
  sectionId: string;
  fiscalYearId: string;
  month: number;
  hours: number;
  reason: string;
  foldHoursAtEntry: number | null;
  changedBy: string;
  changedAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}): ActualAdjustmentRow {
  return { ...record };
}

/**
 * Un-revoked slips for a fiscal year - the set that actually moves numbers.
 *
 * Filtered in SQL rather than in the caller so no read path can forget. actual-merge.ts
 * filters again; see its header for why that is not redundant.
 *
 * A fiscal year holds at most a few hundred slips (288 section-months, and most carry
 * none), so this loads flat and folds in TypeScript like every other total in this layer.
 *
 * @param client - client to read through, defaulting to the global one. See
 *   findActualsByFiscalYear() for the one-snapshot requirement the parameter exists to
 *   serve.
 */
export async function findActiveAdjustmentsByFiscalYear(
  fiscalYearId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<ActualAdjustmentRow[]> {
  const records = await client.actualAdjustment.findMany({
    where: { fiscalYearId, revokedAt: null },
    select: ADJUSTMENT_ROW_SELECT,
    orderBy: [{ sectionId: "asc" }, { month: "asc" }, { changedAt: "asc" }, { id: "asc" }],
  });
  return records.map(toAdjustmentRow);
}

/**
 * Every slip for one section-month, INCLUDING revoked ones, newest first.
 *
 * The history view. Revoked slips are returned on purpose: seeing that a figure was
 * entered, revoked, and re-entered differently is the point of keeping them.
 *
 * `id` breaks ties after `changedAt` because a batch import writes many slips inside one
 * transaction and can land several in the same millisecond - without the tiebreak the
 * displayed order would vary between page loads for the same data.
 */
export async function findAdjustmentsBySectionMonth(
  sectionId: string,
  fiscalYearId: string,
  month: number,
): Promise<ActualAdjustmentRow[]> {
  assertFiscalMonth(month);
  const records = await prisma.actualAdjustment.findMany({
    where: { sectionId, fiscalYearId, month },
    select: ADJUSTMENT_ROW_SELECT,
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
  });
  return records.map(toAdjustmentRow);
}

/** Every slip for a fiscal year, including revoked ones. Backs the audit screen. */
export async function findAllAdjustmentsByFiscalYear(
  fiscalYearId: string,
): Promise<ActualAdjustmentRow[]> {
  const records = await prisma.actualAdjustment.findMany({
    where: { fiscalYearId },
    select: ADJUSTMENT_ROW_SELECT,
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
  });
  return records.map(toAdjustmentRow);
}

/**
 * Reads the folded `Actual.totalHours` for every section-month a batch of slips touches.
 *
 * MUST run inside the same transaction as the insert. The read-then-insert window is not
 * theoretical: the attendance fetch is scheduled at 09:05 and 15:05 and re-folds whatever
 * months its file covers, so a slip typed at 09:05 could otherwise record a base the row
 * no longer holds - manufacturing the exact false alarm this column exists to avoid, or
 * worse, recording the POST-fold base for hours tallied against the pre-fold one and
 * hiding a real double-count.
 *
 * One `findMany` over the cross product of the batch's sections and months rather than an
 * `OR` of exact keys: 24 sections x 12 months of exact tuples is ~864 bind parameters,
 * close enough to SQLite's default 999 that a wider paste would fail on a limit nobody
 * would connect to this function. The cross product costs 37 parameters and a few extra
 * rows, and lookups are by exact key anyway.
 */
async function readFoldBases(
  tx: Prisma.TransactionClient,
  inputs: readonly ActualAdjustmentInput[],
): Promise<Map<string, number>> {
  const fiscalYearIds = [...new Set(inputs.map((input) => input.fiscalYearId))];
  const sectionIds = [...new Set(inputs.map((input) => input.sectionId))];
  const months = [...new Set(inputs.map((input) => input.month))];
  const records = await tx.actual.findMany({
    where: {
      fiscalYearId: { in: fiscalYearIds },
      sectionId: { in: sectionIds },
      month: { in: months },
    },
    select: { sectionId: true, fiscalYearId: true, month: true, totalHours: true },
  });
  const bases = new Map<string, number>();
  for (const record of records) {
    bases.set(
      foldKeyOf(record.fiscalYearId, record.sectionId, record.month),
      record.totalHours,
    );
  }
  return bases;
}

/** Same shape as actual-merge.ts's keyOf(); see there for why the year is in the key. */
function foldKeyOf(fiscalYearId: string, sectionId: string, month: number): string {
  return `${fiscalYearId}|${sectionId}|${month}`;
}

/**
 * The base to store for one slip: the section-month's folded hours, or 0 when it has no
 * `Actual` row.
 *
 * 0 RATHER THAN NULL for the missing-row case, and the distinction decides whether the
 * check works at all for 8月. "No folded row" means the fold contributed zero - a true
 * statement, and one that a later import moves off zero, tripping the drift check exactly
 * when it should. Null would mean "not recorded", which actual-merge.ts skips, so the most
 * dangerous slips - entered for a section whose detail had not arrived yet - would be the
 * only ones never checked.
 */
function foldBaseOf(
  bases: ReadonlyMap<string, number>,
  input: ActualAdjustmentInput,
): number {
  return (
    bases.get(foldKeyOf(input.fiscalYearId, input.sectionId, input.month)) ?? 0
  );
}

/**
 * Appends one slip. Returns its id, so the caller can offer an immediate revoke.
 *
 * Records the section-month's current folded hours as the slip's base, inside the same
 * transaction as the insert - see readFoldBases().
 *
 * @throws see assertAdjustmentInput.
 */
export async function createActualAdjustment(
  input: ActualAdjustmentInput,
): Promise<string> {
  assertAdjustmentInput(input);
  const created = await prisma.$transaction(async (tx) => {
    const folds = await readFoldBases(tx, [input]);
    return tx.actualAdjustment.create({
      data: {
        sectionId: input.sectionId,
        fiscalYearId: input.fiscalYearId,
        month: input.month,
        hours: input.hours,
        reason: input.reason.trim(),
        changedBy: ADJUSTMENT_ACTOR,
        foldHoursAtEntry: foldBaseOf(folds, input),
      },
      select: { id: true },
    });
  });
  return created.id;
}

/**
 * All-or-nothing bulk append. Returns the number of slips written.
 *
 * Every input is validated BEFORE the transaction opens, so a bad row in the middle of a
 * pasted sheet fails the whole paste with a message about that row, rather than committing
 * the rows above it. A half-imported back-fill is the worst outcome available here: the
 * totals would be wrong by an amount nobody can derive without re-reading the source
 * sheet.
 *
 * `createMany` rather than a loop, unlike upsertActualsBulk(): there is no unique key to
 * conflict on, so no idempotency to preserve. Note the consequence - running the same
 * paste twice DOUBLES the hours instead of overwriting. That is correct for an append-only
 * table (two identical slips are two facts), and it is why the entry UI must show the
 * existing slips for a section-month before accepting a new one.
 *
 * The transaction is now EXPLICIT, not for the insert's own atomicity (`createMany` already
 * has that) but so the `foldHoursAtEntry` read and the insert see the same folded figures.
 * See readFoldBases() for the scheduled re-fold that makes the window real.
 *
 * @throws see assertAdjustmentInput - nothing is written.
 */
export async function createActualAdjustmentsBulk(
  inputs: readonly ActualAdjustmentInput[],
): Promise<number> {
  for (const input of inputs) {
    assertAdjustmentInput(input);
  }
  if (inputs.length === 0) {
    return 0;
  }
  return prisma.$transaction(async (tx) => {
    const folds = await readFoldBases(tx, inputs);
    const result = await tx.actualAdjustment.createMany({
      data: inputs.map((input) => ({
        sectionId: input.sectionId,
        fiscalYearId: input.fiscalYearId,
        month: input.month,
        hours: input.hours,
        reason: input.reason.trim(),
        changedBy: ADJUSTMENT_ACTOR,
        foldHoursAtEntry: foldBaseOf(folds, input),
      })),
    });
    return result.count;
  });
}

/**
 * Soft-revokes one slip. Returns false when it does not exist or was already revoked.
 *
 * `updateMany` with `revokedAt: null` in the WHERE, not `update` by id, so the check and
 * the write are one statement. Mirrors AttendanceRaw's soft supersede (D-229): reading
 * the row, testing `revokedAt`, then updating leaves a window where two clicks both pass
 * the test and the second overwrites the first revocation's timestamp.
 *
 * Returning false rather than throwing: "already revoked" is the expected outcome of a
 * double click, not a fault. The caller MUST surface it - a silently ignored false reads
 * on screen as a successful revoke that did not happen.
 */
export async function revokeActualAdjustment(id: string): Promise<boolean> {
  const result = await prisma.actualAdjustment.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: ADJUSTMENT_ACTOR },
  });
  return result.count > 0;
}

/** Count of un-revoked slips for a fiscal year. Cheap enough for a page header badge. */
export async function countActiveAdjustmentsByFiscalYear(
  fiscalYearId: string,
): Promise<number> {
  return prisma.actualAdjustment.count({
    where: { fiscalYearId, revokedAt: null },
  });
}
