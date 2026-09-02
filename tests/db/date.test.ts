import { describe, expect, it } from "vitest";

import { BUSINESS_TIME_ZONE, formatBusinessTimestamp } from "@/lib/db/date";

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
