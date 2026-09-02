// Row-level read/write access to the `actual` table.
//
// Structural mirror of plan.repo.ts, same scope boundary: flat rows only, no
// `groupBy` / `_sum` / nested `include`. A fiscal year is 288 rows, so every
// cross-section or cross-month total is folded by pure TypeScript in the
// aggregation layer - testable without a database, and portable to PostgreSQL.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ACTUAL_SOURCE_MANUAL, assertActualSource } from "./actual-source";
import { assertFiscalMonth } from "./date";
import { assertFiniteHours } from "./hours";
import type { ActualRow, ActualUpsertInput } from "./types";

/** Shape projected by the reads; keeps generated Prisma types out of the exports. */
interface ActualRecord {
  sectionId: string;
  fiscalYearId: string;
  month: number;
  personnelHours: number;
  overtimeHours: number;
  totalHours: number;
  source: string;
}
const ACTUAL_ROW_SELECT = {
  sectionId: true,
  fiscalYearId: true,
  month: true,
  personnelHours: true,
  overtimeHours: true,
  totalHours: true,
  source: true,
} as const;

/**
 * Maps a database record to the persistence-layer DTO.
 *
 * `source` is asserted rather than passed through (D-198). SQLite has no enum, so the
 * column can hold any string; a value outside the vocabulary would make every
 * `source === "manual"` test on the read side answer false, and a hand-typed baseline
 * would then render as if the attendance import had produced it - which is exactly the
 * claim the marker exists to avoid making.
 */
function toActualRow(record: ActualRecord): ActualRow {
  return {
    sectionId: record.sectionId,
    fiscalYearId: record.fiscalYearId,
    month: record.month,
    personnelHours: record.personnelHours,
    overtimeHours: record.overtimeHours,
    totalHours: record.totalHours,
    source: assertActualSource(record.source),
  };
}

/**
 * Resolves `totalHours`: the supplied value when present, otherwise the sum.
 *
 * Single definition so validation and the write path can never disagree about which
 * number lands in the column.
 */
function resolveTotalHours(input: ActualUpsertInput): number {
  return input.totalHours ?? input.personnelHours + input.overtimeHours;
}

/**
 * Validates one input's month and hour quantities.
 *
 * Extracted so single and bulk writes share one definition of "valid", and so the
 * bulk path can run every check BEFORE opening its transaction.
 *
 * `totalHours` is checked AFTER derivation, not just on the raw input: it is the
 * column the dashboard actually reads, and two finite operands can still sum to
 * Infinity at the top of the double range.
 *
 * @throws if `month` is outside 1..12, or any hour value is not finite.
 */
function assertActualInput(input: ActualUpsertInput): void {
  assertFiscalMonth(input.month);
  assertFiniteHours("personnelHours", input.personnelHours);
  assertFiniteHours("overtimeHours", input.overtimeHours);
  assertFiniteHours("totalHours", resolveTotalHours(input));
}

/**
 * Builds the upsert arguments for one input.
 *
 * `where` uses the composite unique key (sectionId, fiscalYearId, month). Upsert
 * rather than create because the attendance import is re-runnable: recomputing an
 * already-imported month must overwrite, not conflict.
 *
 * `totalHours` is derived as personnelHours + overtimeHours when omitted, and stored
 * verbatim when supplied - the Phase 4 aggregator applies its own exclusion rules
 * (D-107/D-108) and its number is authoritative. No clamping: `overtimeHours` is
 * legally negative (D-105: deductions can exceed additions), so a total below
 * personnelHours - or below zero - is real data, and a `Math.max(0, ...)` would hide
 * anomalous imports instead of surfacing them.
 *
 * Assumes assertActualInput() has already run.
 */
function actualUpsertArgs(input: ActualUpsertInput) {
  const hours = {
    personnelHours: input.personnelHours,
    overtimeHours: input.overtimeHours,
    totalHours: resolveTotalHours(input),
  };
  const key = {
    sectionId: input.sectionId,
    fiscalYearId: input.fiscalYearId,
    month: input.month,
  };
  return {
    where: { sectionId_fiscalYearId_month: key },
    // `?? null` on create only: a new row needs a concrete column value.
    create: {
      ...key,
      ...hours,
      sourceFile: input.sourceFile ?? null,
      fetchedAt: input.fetchedAt ?? null,
    },
    // Forwarded verbatim on update so `undefined` leaves the stored provenance alone
    // and only an explicit `null` clears it - the convention org/config/work-calendar
    // already follow. Coercing here would let any recompute that does not resupply
    // sourceFile (e.g. a JobTitleRule change re-deriving hours) blank out which file
    // the month came from: the numbers change, the trail vanishes, nothing errors.
    update: {
      ...hours,
      sourceFile: input.sourceFile,
      fetchedAt: input.fetchedAt,
    },
    select: { id: true },
  };
}

/**
 * All actual rows for a fiscal year, ordered by (sectionId, month). The consuming
 * adapter indexes by key, but a stable order keeps fixtures and diffs reproducible.
 *
 * Returns the FOLDED figures only - adjustment slips (D-233) are a different table and do
 * not appear here. Call sites that must show 实绩 as D-141 defines it use
 * findEffectiveActualsByFiscalYear() instead; this one stays the plain fold so the
 * attendance-provenance screens can still say what the import itself produced.
 *
 * @param client - client to read through, defaulting to the global one. Supplied by
 *   findEffectiveActualsByFiscalYear() so the folded rows and the slips come out of ONE
 *   snapshot: read independently, a re-fold landing between the two queries would compare
 *   a slip's recorded base against a `totalHours` from a different instant and raise a
 *   drift warning for a section-month that never drifted.
 */
export async function findActualsByFiscalYear(
  fiscalYearId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<ActualRow[]> {
  const records = await client.actual.findMany({
    where: { fiscalYearId },
    select: ACTUAL_ROW_SELECT,
    orderBy: [{ sectionId: "asc" }, { month: "asc" }],
  });
  return records.map(toActualRow);
}

/** The actual rows of one section within one fiscal year, ordered by month. */
export async function findActualsBySection(
  sectionId: string,
  fiscalYearId: string,
): Promise<ActualRow[]> {
  const records = await prisma.actual.findMany({
    where: { sectionId, fiscalYearId },
    select: ACTUAL_ROW_SELECT,
    orderBy: { month: "asc" },
  });
  return records.map(toActualRow);
}

/**
 * Inserts or updates one actual row.
 *
 * @throws if `month` is outside 1..12. Not optional defensiveness: an out-of-range
 *   month reaches buildOrgRoot(), which writes `months[month - 1]` - JS silently
 *   extends or drops the slot, so the dashboard shows wrong totals with no error.
 * @throws if any hour value is not finite - see hours.ts for why NOT NULL does not
 *   catch this.
 */
export async function upsertActual(input: ActualUpsertInput): Promise<void> {
  assertActualInput(input);
  await prisma.actual.upsert(actualUpsertArgs(input));
}

/**
 * All-or-nothing bulk write. Returns the number of rows written.
 *
 * Every input is validated BEFORE the transaction opens: validating inside the loop
 * would make the failure point depend on input order and pay for a partial write
 * that then rolls back.
 *
 * Uses an upsert loop, not `createMany`: SQLite's `createMany` has no
 * `skipDuplicates`, and re-importing an attendance file must stay idempotent rather
 * than raise a unique-constraint error. 288 upserts in one transaction finish well
 * under a second, so the loop costs nothing worth optimising.
 *
 * @throws if any input has a `month` outside 1..12 or a non-finite hour value -
 *   nothing is written.
 */
export async function upsertActualsBulk(
  inputs: readonly ActualUpsertInput[],
): Promise<number> {
  for (const input of inputs) {
    assertActualInput(input);
  }
  if (inputs.length === 0) {
    return 0;
  }
  await prisma.$transaction(async (tx) => {
    for (const input of inputs) {
      await tx.actual.upsert(actualUpsertArgs(input));
    }
  });
  return inputs.length;
}

/** Row count for a fiscal year; compare with countPlansByFiscalYear() to spot months that were planned but never imported. */
export async function countActualsByFiscalYear(
  fiscalYearId: string,
): Promise<number> {
  return prisma.actual.count({ where: { fiscalYearId } });
}

/**
 * Fiscal months (1 = April) in which at least one figure was typed in by hand.
 *
 * Exists so the dashboard can caption its own numbers without loading every actual row
 * and without a literal month list in the JSX: the months that predate go-live are a
 * property of the data, and a hard-coded 「4~7 月」 footnote silently becomes wrong the
 * first time 8月 is back-filled the same way (D-198).
 *
 * `distinct` rather than a groupBy: only the month set is needed, and the caller sorts
 * nothing - the ascending order comes from the query so two callers cannot disagree.
 */
export async function findManualBaselineMonthsByFiscalYear(
  fiscalYearId: string,
): Promise<readonly number[]> {
  const rows = await prisma.actual.findMany({
    where: { fiscalYearId, source: ACTUAL_SOURCE_MANUAL },
    select: { month: true },
    distinct: ["month"],
    orderBy: { month: "asc" },
  });
  return rows.map((row) => row.month);
}
