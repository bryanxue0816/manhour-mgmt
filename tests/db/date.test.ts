import { describe, expect, it } from "vitest";

import {
  BUSINESS_TIME_ZONE,
  calendarMonthLabel,
  fiscalMonthFromCalendarLabel,
  formatBusinessTimestamp,
} from "@/lib/db/date";

/**
 * Same instant rendered in UTC, for contrast assertions.
 *
 * Built here rather than imported because the point is to compare against a formatter
 * that is definitely NOT the one under test.
 */
const UTC_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

describe("formatBusinessTimestamp", () => {
  it("projects an instant onto the business wall clock", () => {
    // 2026-08-19 13:24 plant-local.
    const instant = new Date("2026-08-19T05:24:00Z");

    expect(formatBusinessTimestamp(instant)).toBe("2026/08/19 13:24");
  });

  it("crosses the day boundary at the business zone, not at UTC", () => {
    // 16:30Z is already past midnight in Asia/Shanghai - the case that exposes a
    // formatter which lost its timeZone option and fell back to UTC.
    const instant = new Date("2026-08-18T16:30:00Z");

    expect(formatBusinessTimestamp(instant)).toBe("2026/08/19 00:30");
    expect(formatBusinessTimestamp(instant)).not.toBe(UTC_FORMAT.format(instant));
  });

  it("renders midnight as 00:30 rather than 24:30", () => {
    // zh-CN resolves `hour12: false` to hourCycle h23. Locales that resolve to h24
    // (ja-JP historically) would render the previous day's "24:30" here, which reads
    // as a different day on an audit screen.
    const instant = new Date("2026-08-18T16:30:00Z");

    expect(formatBusinessTimestamp(instant)).toContain(" 00:30");
  });

  it("uses a zero-padded, sortable field order", () => {
    // The audit table is scanned top-to-bottom by eye; a single-digit month would
    // break the column alignment that makes that scan possible.
    const instant = new Date("2026-01-02T01:02:00Z");

    expect(formatBusinessTimestamp(instant)).toBe("2026/01/02 09:02");
  });

  it("keeps the business zone pinned to Asia/Shanghai", () => {
    // Guards the constant itself: the fiscal-boundary logic in this module and the
    // timestamps on screen must agree on one zone (D-189).
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Shanghai");
  });
});

describe("calendarMonthLabel", () => {
  // Every other screen spells months in fiscal terms ("26/08"). The adjustment sheet
  // is read next to a hand tally headed 「2026年8月」, so it needs the calendar
  // spelling - and the three-month April=1 offset is exactly the kind of arithmetic
  // that gets redone by eye and gets it wrong.

  it("renders fiscal month 1 as April of the same calendar year", () => {
    expect(calendarMonthLabel(2026, 1)).toBe("2026年4月");
  });

  it("renders a mid-year month", () => {
    expect(calendarMonthLabel(2026, 6)).toBe("2026年9月");
  });

  it("renders December as fiscal month 9", () => {
    expect(calendarMonthLabel(2026, 9)).toBe("2026年12月");
  });

  it("rolls into the next calendar year at fiscal month 10", () => {
    // The boundary that makes this function worth its own tests: FY2026 month 10 is
    // January 2027, not January 2026.
    expect(calendarMonthLabel(2026, 10)).toBe("2027年1月");
  });

  it("renders the last fiscal month as March of the next calendar year", () => {
    expect(calendarMonthLabel(2026, 12)).toBe("2027年3月");
  });

  it("does not zero-pad the month", () => {
    // 「2026年04月」 is not how the figure is written on paper, and the label sits next
    // to the paper tally.
    expect(calendarMonthLabel(2026, 1)).not.toContain("04");
  });

  it("round-trips through fiscalMonthFromCalendarLabel", () => {
    // The two functions are inverses; this is the assertion that keeps them from
    // drifting apart when only one of them is edited.
    for (const month of [1, 2, 6, 9, 10, 12]) {
      expect(fiscalMonthFromCalendarLabel(calendarMonthLabel(2026, month), 2026)).toBe(month);
    }
  });

  it("throws on a month outside 1..12", () => {
    expect(() => calendarMonthLabel(2026, 0)).toThrow();
    expect(() => calendarMonthLabel(2026, 13)).toThrow();
  });
});
