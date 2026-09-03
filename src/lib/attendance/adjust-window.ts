/**
 * Which months an 实绩 adjustment slip may be written against (D-233).
 *
 * Adjustments happen 只在次月: the month has to be closed before a hand tally of it
 * exists, and a slip against a month the fold is still updating is arithmetic against a
 * moving base. The window is therefore "the previous calendar month, plus any earlier
 * month of the same fiscal year" - back-filling is allowed because a missed window would
 * otherwise leave a month permanently unadjustable except by editing the database.
 *
 * Two traps this module exists to contain, both of which fail SILENTLY:
 *
 *   * April crosses the fiscal year. In April 2027 the previous month is March 2027,
 *     which is FY2026 month 12 - not FY2027. Resolving the fiscal year with
 *     findCurrentFiscalYear() would file it under FY2027, and because assertFiscalMonth()
 *     validates only the range 1..12 and never asks which year the month belongs to,
 *     nothing raises. The hours land in a year nobody has opened yet.
 *   * The 00:00-08:00 window. At 00:30 plant-local on 1 September the UTC date is still
 *     31 August, so UTC arithmetic answers "previous month = July". Every entry point
 *     here goes through businessDayOf() first.
 *
 * `now` is a parameter rather than a call to the clock inside these functions, matching
 * the convention in import-staleness: a function that reads the clock itself can only be
 * tested on the day the assertion happens to hold, which would leave the April case
 * unverifiable for eleven months of every year.
 */

import {
  businessDayOf,
  calendarMonthLabel,
  fiscalMonthLabel,
  fiscalMonthOf,
  fiscalYearOf,
} from "@/lib/db/date";

/** One selectable month, labelled in both the calendar and the fiscal spelling. */
export interface AdjustableMonth {
  readonly fiscalYear: number;
  /** Fiscal month, 1 = April. */
  readonly month: number;
  /** `2026年8月` - matches the heading on the hand tally being compared against. */
  readonly calendarLabel: string;
  /** `26/08` - matches every other screen in the app. */
  readonly fiscalLabel: string;
}

function describe(fiscalYear: number, month: number): AdjustableMonth {
  return {
    fiscalYear,
    month,
    calendarLabel: calendarMonthLabel(fiscalYear, month),
    fiscalLabel: fiscalMonthLabel(fiscalYear, month),
  };
}

/**
 * The default month to adjust: the calendar month before `now`.
 *
 * @throws if `now` is an invalid Date - answering for the epoch would silently offer
 *   December 1969 as the adjustable month.
 */
export function resolveAdjustTarget(now: Date): AdjustableMonth {
  const today = businessDayOf(now);
  // Date.UTC() normalises a month index of -1 into December of the previous year, so
  // this handles the January -> December rollover without a branch. Day 1 is used rather
  // than "today minus one month" because the 31st has no counterpart in February.
  const targetDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return describe(fiscalYearOf(targetDay), fiscalMonthOf(targetDay));
}

/**
 * Every month a slip may currently be written against, earliest first.
 *
 * Deliberately not filtered by whether the month has data: a month with no fold at all
 * still needs a slip (that is how a missing HR share gets corrected), and hiding it would
 * make the fix unreachable from the UI. The screen shows 尚未导入 per 課 instead.
 *
 * @throws if `now` is an invalid Date - see resolveAdjustTarget().
 */
export function listAdjustableMonths(now: Date): readonly AdjustableMonth[] {
  const target = resolveAdjustTarget(now);
  return Array.from({ length: target.month }, (_unused, index) =>
    describe(target.fiscalYear, index + 1),
  );
}

/**
 * Whether (fiscalYear, month) is inside the window.
 *
 * Returns false rather than throwing on malformed input, because the caller is a Server
 * Action handling raw form strings: those return a rejection message, and an exception
 * here would surface as a 500 with no explanation. The fiscal year is checked as well as
 * the month - month 5 is adjustable, but only in the right year, and this is the check
 * that stops a forged year field from parking August's hours in FY2027.
 */
export function isAdjustable(fiscalYear: number, month: number, now: Date): boolean {
  if (!Number.isInteger(fiscalYear) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12) return false;
  const target = resolveAdjustTarget(now);
  return fiscalYear === target.fiscalYear && month <= target.month;
}
