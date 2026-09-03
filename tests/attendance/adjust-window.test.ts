// D-233 / D-239: which months an adjustment slip may be written against.
//
// Pure clock arithmetic, so `now` is a PARAMETER rather than read inside the
// functions - the same convention as import-staleness.test.ts, and for the same
// reason: a function that reads the clock itself makes every assertion here depend
// on the day the suite happens to run, so the April cross-fiscal-year case below
// would be unverifiable for eleven months of the year.
//
// The two cases that are easy to get wrong and invisible on screen:
//
//   * April. "Adjust last month" in April 2027 means March 2027, which belongs to
//     FY2026, not FY2027. Resolving the fiscal year with findCurrentFiscalYear()
//     would file the slip under FY2027 - and because assertFiscalMonth() only
//     checks 1..12 and never checks belonging, nothing would raise. The hours would
//     land in a year nobody is looking at.
//   * The 00:00-08:00 window. At 00:30 plant-local on 1 September the UTC date is
//     still 31 August, so UTC arithmetic answers "last month = July". Everything
//     routes through businessDayOf() to keep that from happening.

import { describe, expect, it } from "vitest";

import {
  isAdjustable,
  listAdjustableMonths,
  resolveAdjustTarget,
} from "@/lib/attendance/adjust-window";

/** 2026-09-03 13:00 plant-local - a plain mid-month instant. */
const SEP_2026 = new Date("2026-09-03T05:00:00Z");

describe("resolveAdjustTarget", () => {
  it("points at the previous calendar month", () => {
    const target = resolveAdjustTarget(SEP_2026);

    expect(target.fiscalYear).toBe(2026);
    // August is fiscal month 5 (April = 1).
    expect(target.month).toBe(5);
    expect(target.calendarLabel).toBe("2026年8月");
    expect(target.fiscalLabel).toBe("26/08");
  });

  it("crosses into the previous fiscal year in April", () => {
    // The whole reason this module exists. April 2027 adjusts March 2027, which is
    // FY2026 month 12 - NOT FY2027 month 12 (that would be March 2028).
    const target = resolveAdjustTarget(new Date("2027-04-05T05:00:00Z"));

    expect(target.fiscalYear).toBe(2026);
    expect(target.month).toBe(12);
    expect(target.calendarLabel).toBe("2027年3月");
    expect(target.fiscalLabel).toBe("27/03");
  });

  it("crosses the calendar year without leaving the fiscal year", () => {
    // January 2027 adjusts December 2026: fiscal month 9, still FY2026.
    const target = resolveAdjustTarget(new Date("2027-01-15T05:00:00Z"));

    expect(target.fiscalYear).toBe(2026);
    expect(target.month).toBe(9);
    expect(target.calendarLabel).toBe("2026年12月");
  });

  it("resolves the previous month at the business zone, not at UTC", () => {
    // 2026-08-31T16:30Z is 2026-09-01 00:30 plant-local, so last month is August.
    // Read as a UTC date this instant is still 31 August and would answer July -
    // a one-month misfiling that only ever happens between midnight and 08:00.
    const target = resolveAdjustTarget(new Date("2026-08-31T16:30:00Z"));

    expect(target.calendarLabel).toBe("2026年8月");
    expect(target.month).toBe(5);
  });

  it("rejects an invalid instant instead of answering for the epoch", () => {
    expect(() => resolveAdjustTarget(new Date("not a date"))).toThrow();
  });
});

describe("listAdjustableMonths", () => {
  it("offers the previous month plus every earlier month of the same fiscal year", () => {
    // The user's ruling: default to last month, allow back-filling earlier months of
    // the same fiscal year, so a missed window is recoverable without a DB edit.
    const months = listAdjustableMonths(SEP_2026);

    expect(months.map((entry) => entry.month)).toEqual([1, 2, 3, 4, 5]);
    expect(months.every((entry) => entry.fiscalYear === 2026)).toBe(true);
  });

  it("ends at the previous month, never at the current one", () => {
    // Adjustments happen 只在次月 - the current month is still collecting data, and
    // a slip against it would be arithmetic against a moving base.
    const months = listAdjustableMonths(SEP_2026);

    // September is fiscal month 6.
    expect(months.map((entry) => entry.month)).not.toContain(6);
  });

  it("offers the whole just-closed fiscal year in April", () => {
    const months = listAdjustableMonths(new Date("2027-04-05T05:00:00Z"));

    expect(months).toHaveLength(12);
    expect(months.every((entry) => entry.fiscalYear === 2026)).toBe(true);
    expect(months.at(-1)?.month).toBe(12);
    expect(months.at(-1)?.calendarLabel).toBe("2027年3月");
  });

  it("labels each month with both the calendar and the fiscal spelling", () => {
    // Two spellings on purpose: the operator's hand tally is headed "2026年8月",
    // while every other screen in the app says "26/08". Showing only one of them
    // makes the reader translate, which is where the three-month April=1 offset
    // gets reintroduced by eye.
    const months = listAdjustableMonths(SEP_2026);

    expect(months[0]?.calendarLabel).toBe("2026年4月");
    expect(months[0]?.fiscalLabel).toBe("26/04");
  });

  it("agrees with resolveAdjustTarget on the last entry", () => {
    const months = listAdjustableMonths(SEP_2026);

    expect(months.at(-1)).toEqual(resolveAdjustTarget(SEP_2026));
  });
});

describe("isAdjustable", () => {
  it("accepts the previous month", () => {
    expect(isAdjustable(2026, 5, SEP_2026)).toBe(true);
  });

  it("accepts an earlier month of the same fiscal year", () => {
    expect(isAdjustable(2026, 1, SEP_2026)).toBe(true);
  });

  it("rejects the current month", () => {
    expect(isAdjustable(2026, 6, SEP_2026)).toBe(false);
  });

  it("rejects a future month", () => {
    expect(isAdjustable(2026, 12, SEP_2026)).toBe(false);
  });

  it("rejects the right month of the wrong fiscal year", () => {
    // Month 5 IS adjustable - but only in FY2026. This is the assertion that keeps
    // a forged fiscalYear field from parking August's hours in the next year.
    expect(isAdjustable(2027, 5, SEP_2026)).toBe(false);
    expect(isAdjustable(2025, 5, SEP_2026)).toBe(false);
  });

  it("rejects a month outside 1..12 without throwing", () => {
    // Called from a Server Action on raw form input, which returns a rejection
    // message rather than throwing - so an out-of-range month has to come back as
    // false, not as an exception that becomes a 500.
    expect(isAdjustable(2026, 0, SEP_2026)).toBe(false);
    expect(isAdjustable(2026, 13, SEP_2026)).toBe(false);
    expect(isAdjustable(2026, 5.5, SEP_2026)).toBe(false);
    expect(isAdjustable(2026, Number.NaN, SEP_2026)).toBe(false);
  });
});
