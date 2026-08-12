// Fiscal-year repository.
//
// A fiscal year runs April 1 -> March 31 and at most ONE row may carry
// `isCurrent = true`. SQLite has no partial unique index
// (`... WHERE is_current`), so that invariant cannot be delegated to the
// database - it is upheld here by clearing every other row and setting the
// target inside a single transaction. Any write path that can raise the flag
// must go through `applyCurrentFlag`, otherwise two rows can end up true and
// every "which year am I looking at?" lookup becomes order-dependent.

import type { Prisma, FiscalYear } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertCalendarDay } from "./date";
import type { FiscalYearDto, FiscalYearUpsertInput } from "./types";

/** Maps a Prisma row to the DTO so the ORM type never escapes this module. */
function toFiscalYearDto(row: FiscalYear): FiscalYearDto {
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    startDate: row.startDate,
    endDate: row.endDate,
    isCurrent: row.isCurrent,
  };
}

/**
 * Clears `isCurrent` on every row except `exceptId`.
 *
 * Takes a transaction client rather than the global `prisma` so callers that are
 * already inside `$transaction` can reuse it - nesting `$transaction` calls would
 * open a second connection-level transaction and defeat the atomicity this
 * invariant depends on.
 */
async function clearOtherCurrentFlags(
  tx: Prisma.TransactionClient,
  exceptId?: string,
): Promise<void> {
  await tx.fiscalYear.updateMany({
    where: {
      isCurrent: true,
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    data: { isCurrent: false },
  });
}

/** All fiscal years, newest first. */
export async function findAllFiscalYears(): Promise<FiscalYearDto[]> {
  const rows = await prisma.fiscalYear.findMany({ orderBy: { year: "desc" } });
  return rows.map(toFiscalYearDto);
}

/** One fiscal year by primary key, or null when absent. */
export async function findFiscalYearById(id: string): Promise<FiscalYearDto | null> {
  const row = await prisma.fiscalYear.findUnique({ where: { id } });
  return row === null ? null : toFiscalYearDto(row);
}

/**
 * The fiscal year flagged `isCurrent`, or null when none is flagged.
 *
 * Ordered by `year desc` purely defensively: the single-true invariant is upheld
 * by this module, but a row inserted through a migration or a raw SQL fix could
 * still break it, and picking the newest year is the least surprising fallback.
 */
export async function findCurrentFiscalYear(): Promise<FiscalYearDto | null> {
  const row = await prisma.fiscalYear.findFirst({
    where: { isCurrent: true },
    orderBy: { year: "desc" },
  });
  return row === null ? null : toFiscalYearDto(row);
}

/** One fiscal year by its start year (`year` is `@unique`), or null when absent. */
export async function findFiscalYearByYear(
  year: number,
): Promise<FiscalYearDto | null> {
  const row = await prisma.fiscalYear.findUnique({ where: { year } });
  return row === null ? null : toFiscalYearDto(row);
}

/**
 * Upserts a fiscal year keyed on `year`, the natural key - re-running the seed
 * must update FY2026 rather than insert a duplicate.
 *
 * `isCurrent` is optional and its two falsy-adjacent states differ: `undefined`
 * leaves the stored flag alone on the update branch (and falls back to the
 * schema default `false` on create), while an explicit `false` clears it.
 * Only `true` needs the transaction, because only `true` can violate the
 * at-most-one invariant; the clear-others step and the write are therefore
 * batched atomically.
 */
export async function upsertFiscalYear(
  input: FiscalYearUpsertInput,
): Promise<FiscalYearDto> {
  // Calendar-day check belongs HERE, at the import boundary, not on the read side.
  // formatDateOnly() throws when it meets a timestamped value, and /admin renders
  // fiscal-year dates in a Server Component with no error boundary - so a single row
  // written with a time component takes the whole page to a 500 at read time, far
  // from the code that caused it. Rejecting on write keeps the failure attributable.
  const startDate = assertCalendarDay(input.startDate);
  const endDate = assertCalendarDay(input.endDate);

  const create = {
    name: input.name,
    year: input.year,
    startDate,
    endDate,
    isCurrent: input.isCurrent,
  };
  const update = {
    name: input.name,
    startDate,
    endDate,
    isCurrent: input.isCurrent,
  };

  if (input.isCurrent !== true) {
    const row = await prisma.fiscalYear.upsert({
      where: { year: input.year },
      create,
      update,
    });
    return toFiscalYearDto(row);
  }

  const row = await prisma.$transaction(async (tx) => {
    // Clear first: the target row may not exist yet, so it cannot be excluded by
    // id here. The upsert immediately below re-raises the flag on the winner.
    await clearOtherCurrentFlags(tx);
    return tx.fiscalYear.upsert({ where: { year: input.year }, create, update });
  });
  return toFiscalYearDto(row);
}

/**
 * Clears `isCurrent` on all others then sets it, inside ONE transaction.
 *
 * The transaction is the only thing standing in for the partial unique index
 * SQLite lacks: run as two separate statements, a crash in between leaves either
 * zero or two current years.
 *
 * @throws if `id` does not exist - the `update` fails, the whole transaction
 *   rolls back and the previous current year is preserved. Deliberately not
 *   caught: silently swallowing it would clear the flag with nothing to replace it.
 */
export async function setCurrentFiscalYear(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await clearOtherCurrentFlags(tx, id);
    await tx.fiscalYear.update({ where: { id }, data: { isCurrent: true } });
  });
}
