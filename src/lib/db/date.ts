// Date and fiscal-month helpers.
//
// The fiscal year runs April -> March (D-004). Two numbering schemes coexist and
// must never be confused:
//
//   * database `month` column : 1..12, where 1 = April  (this module's domain)
//   * frontend `months[]`     : 0..11, where 0 = April  (array index)
//
// The single legal conversion point between the two is buildOrgRoot() in
// adapter/org-tree.ts. Everything else stays in 1-based fiscal months.
//
// A second distinction matters just as much, and `Date` hides it. Two kinds of value
// are both spelled `Date` in TypeScript, and they need OPPOSITE handling:
//
//   * calendar day - "2026-04-01": a date with no time, canonically stored as UTC
//     midnight. Produced by parseDateOnly() or businessDayOf(). This is what the
//     database holds and what every function in this module consumes.
//   * instant      - "now": a point on the timeline, from `new Date()` or a
//     timestamp column. WHICH calendar day it falls on depends on a time zone.
//
// Passing an instant where a calendar day was expected used to be silently wrong.
// Under UTC+8 an instant between 00:00 and 08:00 local has a UTC date one day
// earlier, so at 03:00 on 1 April a fiscal lookup answered "month 12 of the
// PREVIOUS fiscal year" - the new year's first morning written into last year's
// March. Functions here therefore reject instants outright, and businessDayOf() is
// the one supported way to turn an instant into a calendar day.

import type { DayType } from "./types";

/** Number of months in a fiscal year. The frontend hard-depends on this being 12. */
export const FISCAL_MONTH_COUNT = 12;

/** Calendar month (1-12) that fiscal month 1 maps to. */
const FISCAL_YEAR_START_CALENDAR_MONTH = 4;

const DAY_TYPES: readonly DayType[] = ["工作日", "周末", "节假日", "年例休"];

const MS_PER_DAY = 86_400_000;

/**
 * IANA time zone the business operates in.
 *
 * Hard-coded rather than read from the host clock deliberately. Fiscal boundaries
 * are local days at the plant, so a process started with TZ=UTC must still place
 * 2026-04-01 03:00 plant-local in fiscal month 1. Deriving this from local Date
 * components would make the same instant land in a different fiscal year depending
 * on where the process happens to run - a bug that cannot reproduce on the
 * developer's machine, which already sits in this zone.
 */
export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

/**
 * Formatter projecting an instant onto a business-local calendar day.
 *
 * Built once at module load: `Intl.DateTimeFormat` construction is the expensive
 * part, `format` calls are cheap. 'en-CA' is chosen because it yields exactly
 * `YYYY-MM-DD`, which parseDateOnly() already validates.
 */
const BUSINESS_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Asserts `value` is a calendar day - a valid Date at exactly UTC midnight.
 *
 * SQLite has no DATE type, so `work_calendar.date` is a DateTime used as a primary
 * key. A value carrying a time component is a DIFFERENT primary key: two writes for
 * the same calendar day would produce two rows and no error at all, countWorkingDays()
 * would over-count, and every prorated monthly target derived from it would be wrong.
 *
 * This throws instead of truncating on purpose. Truncation is what made the original
 * bug invisible - it accepted an instant and quietly answered for the wrong day.
 * Callers holding an instant must convert explicitly via businessDayOf().
 *
 * @returns the same Date, for use in expression position.
 * @throws if `value` is an invalid Date or carries a non-zero time component.
 */
export function assertCalendarDay(value: Date): Date {
  const time = value.getTime();
  if (Number.isNaN(time)) {
    throw new Error("Invalid Date: expected a calendar day at UTC midnight");
  }
  if (time % MS_PER_DAY !== 0) {
    throw new Error(
      `Not a calendar day: ${value.toISOString()} carries a time component. ` +
        "Convert an instant with businessDayOf() before crossing this boundary.",
    );
  }
  return value;
}

/**
 * The calendar day an instant falls on, in the business time zone.
 *
 * This is the ONLY supported instant -> calendar-day conversion. Use it for
 * `new Date()` and for any timestamp column whose day matters.
 *
 * @example businessDayOf(new Date("2026-03-31T19:00Z")) // 2026-04-01, UTC midnight
 * @throws if `instant` is an invalid Date.
 */
export function businessDayOf(instant: Date): Date {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Invalid Date: cannot resolve a business day");
  }
  return parseDateOnly(BUSINESS_DAY_FORMAT.format(instant));
}

/**
 * Parses an ISO `YYYY-MM-DD` string into a UTC-midnight Date.
 * @throws if the string is not a well-formed calendar date.
 */
export function parseDateOnly(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(`Invalid date-only string: ${iso} (expected YYYY-MM-DD)`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects overflow such as 2026-02-30, which Date.UTC would silently roll over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${iso}`);
  }
  return date;
}

/**
 * Formats a calendar day as `YYYY-MM-DD`.
 *
 * @throws if `value` is not a calendar day. An instant formatted here would render
 *   its UTC date, which under UTC+8 is a day earlier all morning.
 */
export function formatDateOnly(value: Date): string {
  assertCalendarDay(value);
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Formatter projecting an instant onto a business-local wall clock.
 *
 * Built once at module load for the same reason as BUSINESS_DAY_FORMAT: the audit
 * screen formats one timestamp per row, and `toLocaleString` rebuilds the formatter
 * on every call.
 */
const BUSINESS_TIMESTAMP_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Formats an instant as a business-local `YYYY/MM/DD HH:mm`.
 *
 * Shared rather than hand-written per page on purpose (D-189). The zone must be
 * explicit: without it `toLocaleString` inherits the host zone, so an app moved to a
 * UTC server would render every audit row and every import timestamp eight hours off,
 * with nothing on screen to reveal it. Both existing call sites had been written
 * separately and one of them had already lost the `timeZone` option that way.
 *
 * Deliberately NOT formatDateOnly(): that one asserts a calendar day and throws on
 * an instant. The two are different kinds of value and stay different functions.
 */
export function formatBusinessTimestamp(value: Date): string {
  return BUSINESS_TIMESTAMP_FORMAT.format(value);
}

/**
 * Validates a database fiscal month.
 *
 * Called at every write boundary. An out-of-range month would land in a row that
 * buildOrgRoot() then writes to `months[month - 1]` - out of bounds, silently
 * discarded by JS array semantics. Failing loudly here is the whole point.
 *
 * @throws if `month` is not an integer in 1..12.
 */
export function assertFiscalMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > FISCAL_MONTH_COUNT) {
    throw new Error(
      `Invalid fiscal month: ${month} (expected integer 1..${FISCAL_MONTH_COUNT}, 1 = April)`,
    );
  }
}

/**
 * Converts a 1-based fiscal month to the 0-based array index the frontend uses.
 * @throws if `month` is out of range.
 */
export function monthToIndex(month: number): number {
  assertFiscalMonth(month);
  return month - 1;
}

/**
 * Converts a 0-based array index back to a 1-based fiscal month.
 * @throws if `index` is out of range.
 */
export function indexToMonth(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= FISCAL_MONTH_COUNT) {
    throw new Error(
      `Invalid month index: ${index} (expected integer 0..${FISCAL_MONTH_COUNT - 1})`,
    );
  }
  return index + 1;
}

/**
 * Display label for a fiscal month within a given fiscal year, e.g. (2026, 1) ->
 * "26/04" and (2026, 12) -> "27/03".
 *
 * Derived rather than looked up in a table. `types/manhour.ts#MONTHS` holds the
 * same twelve strings but hard-codes FY2026, which is correct for the mock
 * dashboard and wrong for any screen that lets the operator pick a year - the
 * labels would keep saying 26/xx while the data came from FY2027.
 *
 * @throws if `month` is not an integer in 1..12.
 */
export function fiscalMonthLabel(year: number, month: number): string {
  assertFiscalMonth(month);
  const offset = month + FISCAL_YEAR_START_CALENDAR_MONTH - 1;
  // Months 1..9 sit in `year`; 10..12 (Jan..Mar) roll into the next calendar year.
  const calendarYear = offset > 12 ? year + 1 : year;
  const calendarMonth = offset > 12 ? offset - 12 : offset;
  return `${String(calendarYear % 100).padStart(2, "0")}/${String(calendarMonth).padStart(2, "0")}`;
}

/**
 * Fiscal month (1 = April) for a CALENDAR month label such as `2026年4月`.
 *
 * The opposite direction from fiscalMonthLabel(), for figures that arrive worded the way
 * people write months. It lives here, next to the offset it depends on, because a
 * hand-filled sheet says `2026年4月` while `Actual.month` stores a fiscal ordinal in which
 * 4 means July: copying the number straight across files April's hours as July's with no
 * error, no exception, no log line, and a chart that renders perfectly. Routed through a
 * calendar day and fiscalMonthOf() rather than arithmetic on the number, because local
 * arithmetic is exactly where that three-month shift gets reintroduced.
 *
 * @param label `YYYY年M月`, leading zero on the month optional.
 * @param fiscalYear the fiscal year the caller believes the label belongs to.
 * @returns 1..12, 1 = April.
 * @throws if the label is malformed, or if it belongs to a DIFFERENT fiscal year - a
 *   `2027年4月` row inside a FY2026 sheet is a filled-in-the-wrong-file mistake, and
 *   accepting it as FY2026 month 1 would silently double up with April.
 */
export function fiscalMonthFromCalendarLabel(label: string, fiscalYear: number): number {
  const match = /^(\d{4})年(\d{1,2})月$/.exec(label);
  if (!match) {
    throw new Error(`月份格式不认识：${JSON.stringify(label)}（应形如 2026年4月）`);
  }
  const calendarYear = match[1] ?? "";
  const calendarMonth = Number(match[2]);
  if (calendarMonth < 1 || calendarMonth > 12) {
    throw new Error(`月份超范围：${JSON.stringify(label)}`);
  }
  const day = parseDateOnly(
    `${calendarYear}-${String(calendarMonth).padStart(2, "0")}-01`,
  );
  const actualFiscalYear = fiscalYearOf(day);
  if (actualFiscalYear !== fiscalYear) {
    throw new Error(
      `${label} 属于 FY${String(actualFiscalYear)}，不属于本次导入的 FY${String(fiscalYear)}。` +
        "请确认 --year 与文件内容一致。",
    );
  }
  return fiscalMonthOf(day);
}

/**
 * Fiscal month (1 = April) for a calendar day.
 *
 * April..December -> 1..9, January..March -> 10..12.
 *
 * @throws if `value` is not a calendar day. Pass businessDayOf(new Date()) rather
 *   than `new Date()` - see assertCalendarDay().
 */
export function fiscalMonthOf(value: Date): number {
  assertCalendarDay(value);
  const calendarMonth = value.getUTCMonth() + 1;
  const offset = calendarMonth - FISCAL_YEAR_START_CALENDAR_MONTH;
  return offset >= 0 ? offset + 1 : offset + 1 + FISCAL_MONTH_COUNT;
}

/**
 * Fiscal year label for a calendar day, e.g. 2026-03-31 belongs to FY2025.
 * The returned number is the year in which the fiscal year *starts*.
 *
 * @throws if `value` is not a calendar day - see fiscalMonthOf().
 */
export function fiscalYearOf(value: Date): number {
  assertCalendarDay(value);
  const calendarMonth = value.getUTCMonth() + 1;
  return calendarMonth >= FISCAL_YEAR_START_CALENDAR_MONTH
    ? value.getUTCFullYear()
    : value.getUTCFullYear() - 1;
}

/**
 * Inclusive calendar-day bounds of one fiscal month, e.g. (2026, 4) -> 2026-07-01 ..
 * 2026-07-31.
 *
 * Exists because the attendance import writes DAY rows but Actual is a MONTH
 * aggregate (D-126): after a day lands, the whole month has to be re-read and
 * re-folded, and that read needs a range. Deriving the range here rather than at the
 * call site keeps the April=1 offset in exactly one module.
 *
 * `to` is computed as day 0 of the FOLLOWING calendar month, which is the last day of
 * this one - correct for 28/29/30/31 without a length table.
 *
 * @throws if `month` is not an integer in 1..12.
 */
export function fiscalMonthRange(year: number, month: number): { from: Date; to: Date } {
  assertFiscalMonth(month);
  const offset = month + FISCAL_YEAR_START_CALENDAR_MONTH - 1;
  // Months 1..9 sit in `year`; 10..12 (Jan..Mar) roll into the next calendar year.
  const calendarYear = offset > FISCAL_MONTH_COUNT ? year + 1 : year;
  const calendarMonth = offset > FISCAL_MONTH_COUNT ? offset - FISCAL_MONTH_COUNT : offset;
  return {
    from: new Date(Date.UTC(calendarYear, calendarMonth - 1, 1)),
    to: new Date(Date.UTC(calendarYear, calendarMonth, 0)),
  };
}

/** First day (April 1, UTC midnight) of the fiscal year starting in `year`. */
export function fiscalYearStart(year: number): Date {
  return new Date(Date.UTC(year, FISCAL_YEAR_START_CALENDAR_MONTH - 1, 1));
}

/** Last day (March 31, UTC midnight) of the fiscal year starting in `year`. */
export function fiscalYearEnd(year: number): Date {
  return new Date(Date.UTC(year + 1, FISCAL_YEAR_START_CALENDAR_MONTH - 1, 0));
}

/**
 * Narrows an arbitrary string read from the database to a DayType.
 * @throws if the stored value is outside the known set - SQLite cannot enforce
 *   this with an enum, so the check has to happen on read.
 */
export function assertDayType(value: string): DayType {
  const match = DAY_TYPES.find((known) => known === value);
  if (match === undefined) {
    throw new Error(
      `Unknown day type: ${value} (expected one of ${DAY_TYPES.join(", ")})`,
    );
  }
  return match;
}
