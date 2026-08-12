// Work-calendar repository (D-202): the working-day classification used to prorate
// monthly targets by elapsed working days instead of calendar days.
//
// !! NO CONSUMERS - DORMANT AS OF D-168 (2026-08-07) !!
//
// D-168 revoked D-202: a working day is now whatever the daily attendance upload says
// it is (rows present => worked, absent => off), and no standalone calendar is built or
// maintained in v1. So `work_calendar` holds 0 rows and nothing in src/, scripts/ or
// prisma/ calls anything below. Do NOT wire a page, an import or a seed to this file on
// the assumption that it was simply forgotten - that scope was removed deliberately.
//
// This layer is kept because it is complete and correct, and because the revocation has
// a written trigger: the first requirement whose denominator is "应出勤天数" or
// "工作日数" invalidates D-168 and returns to D-202's three-layer design (weekday
// baseline + ~20 manual exceptions per year + attendance reconciliation that only warns,
// never overwrites the denominator). At that point this file is the starting point, not
// a rewrite. Until then, treat every export here as unreachable code.
//
// Two invariants govern this file:
//
// 1. EVERY Date crossing this boundary - read or write - is a calendar day at UTC
//    midnight, enforced by assertCalendarDay() on query bounds, on written values,
//    AND on rows read back out (see toWorkCalendarDto). `work_calendar.date` is the
//    primary key and SQLite has no DATE type, so it is stored as a DateTime. A value
//    carrying a time component is a DIFFERENT primary key: two writes for the same
//    calendar day produce two rows and no error at all. countWorkingDays() then
//    over-counts, and every monthly target derived from it is wrong. On the read side
//    an un-normalised bound silently trims a boundary day off the range.
//
//    The read-side check is what makes this invariant hold for data this layer did not
//    write - a raw SQL import, a hand-edited row, or a restored dump can all put a
//    timestamped date in the table, and without it every downstream consumer would
//    inherit the corruption silently. Same reasoning as invariant 2 below: throwing on
//    read is the lesser evil.
//
//    This layer REJECTS rather than truncates. Truncating hid a real bug: under UTC+8
//    an instant before 08:00 local has a UTC date one day earlier, so `new Date()`
//    silently queried the wrong day every morning. Callers holding an instant must
//    convert with businessDayOf() and thereby state which zone they meant.
//
// 2. dayType is narrowed with assertDayType() on read. The column is a plain String
//    because SQLite has no enum, so a misspelt value would type-check as DayType and
//    then quietly fall out of the '工作日' count. Throwing on read is the lesser
//    evil: a loud failure beats a wrong number nobody can trace.

import type { WorkCalendar } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertCalendarDay, assertDayType } from "./date";
import type { WorkCalendarDto, WorkCalendarUpsertInput } from "./types";

/**
 * Maps a Prisma row to the DTO, validating the stored dayType.
 * @throws if `row.dayType` is outside the known DayType set - see invariant 2.
 */
function toWorkCalendarDto(row: WorkCalendar): WorkCalendarDto {
  return {
    date: assertCalendarDay(row.date),
    dayType: assertDayType(row.dayType),
    remark: row.remark,
  };
}

/**
 * All calendar entries between `from` and `to`, INCLUSIVE of both bounds,
 * ordered by date ascending.
 *
 * @throws if either bound is not a calendar day at UTC midnight - see invariant 1.
 */
export async function findCalendarRange(
  from: Date,
  to: Date,
): Promise<WorkCalendarDto[]> {
  const rows = await prisma.workCalendar.findMany({
    where: { date: { gte: assertCalendarDay(from), lte: assertCalendarDay(to) } },
    orderBy: { date: "asc" },
  });
  return rows.map(toWorkCalendarDto);
}

/**
 * One calendar day by date, or null when absent.
 * @throws if `date` is not a calendar day at UTC midnight.
 */
export async function findCalendarDay(date: Date): Promise<WorkCalendarDto | null> {
  const row = await prisma.workCalendar.findUnique({
    where: { date: assertCalendarDay(date) },
  });
  return row === null ? null : toWorkCalendarDto(row);
}

/**
 * Number of rows classified '工作日' between `from` and `to`, INCLUSIVE.
 *
 * Counted in the database rather than by loading and filtering in memory: the
 * calendar spans multiple fiscal years (thousands of rows) and this is a pure count
 * with no cross-table aggregation, so there is nothing for the application layer to
 * add. Note that a day with no row is not counted - the calendar is expected to be
 * fully seeded for any range being prorated.
 *
 * @throws if either bound is not a calendar day at UTC midnight.
 */
export async function countWorkingDays(from: Date, to: Date): Promise<number> {
  return prisma.workCalendar.count({
    where: {
      dayType: "工作日",
      date: { gte: assertCalendarDay(from), lte: assertCalendarDay(to) },
    },
  });
}

/**
 * Creates or updates one calendar day.
 * @throws if `input.date` is not a calendar day at UTC midnight.
 */
export async function upsertCalendarDay(input: WorkCalendarUpsertInput): Promise<void> {
  const date = assertCalendarDay(input.date);
  await prisma.workCalendar.upsert({
    where: { date },
    create: { date, dayType: input.dayType, remark: input.remark ?? null },
    // `remark: undefined` leaves an existing remark untouched; null clears it.
    update: { dayType: input.dayType, remark: input.remark },
  });
}

/**
 * Creates or updates many calendar days in one transaction, returning the number of
 * rows written.
 *
 * An upsert loop rather than createMany: SQLite has no
 * `createMany({ skipDuplicates })` and calendar imports must be idempotent, since a
 * whole year is typically re-uploaded to fix a handful of holidays.
 *
 * Every date is validated BEFORE the transaction opens, matching upsertPlansBulk().
 * Validating inside the loop would make the failure point depend on input order and
 * would pay for a partial write that then rolls back.
 *
 * @throws if any input's date is not a calendar day at UTC midnight - nothing is
 *   written.
 */
export async function upsertCalendarBulk(
  inputs: readonly WorkCalendarUpsertInput[],
): Promise<number> {
  for (const input of inputs) {
    assertCalendarDay(input.date);
  }
  if (inputs.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let written = 0;
    for (const input of inputs) {
      const date = input.date;
      await tx.workCalendar.upsert({
        where: { date },
        create: { date, dayType: input.dayType, remark: input.remark ?? null },
        update: { dayType: input.dayType, remark: input.remark },
      });
      written += 1;
    }
    return written;
  });
}
