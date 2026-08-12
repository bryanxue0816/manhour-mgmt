// D-124's staleness threshold, counted in calendar days (D-170).
//
// The original wording was 「连续 2 个工作日无新文件」, but D-168 revoked WorkCalendar and left
// no working-day predicate to count with. N=3 calendar days is the replacement, chosen to
// clear the longest gap a healthy pipeline produces: a Friday upload followed by nothing over
// the weekend is 3 days old by Monday morning.
//
// The boundary cases below are the point of the file. A threshold that fires one day early
// shouts every Monday and gets ignored; one that fires one day late is silent on exactly the
// day the operator needed to know. Both ends are also projected through businessDayOf()
// first, so the answer is "how many dates have turned over" rather than "how many 24-hour
// periods elapsed" - without that a 06:00 upload compared against 05:00 the next morning
// rounds to 0 and a genuinely missing day reads as fresh.
//
// `now` is a parameter, not a clock read: reading the clock inside the function would make
// every assertion here depend on when the suite happened to run.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  describeImportStaleness,
} from "@/lib/attendance/import-staleness";

/**
 * A plant-local wall-clock instant.
 *
 * Asia/Shanghai is UTC+8 year-round with no DST, so subtracting 8 hours is exact. Written
 * as a helper rather than inline arithmetic because the whole file is about which CALENDAR
 * DAY an instant lands on, and a UTC literal silently shifts that for early-morning times.
 */
function plantTime(
  year: number,
  month: number,
  day: number,
  hour = 6,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

describe("describeImportStaleness - fresh data", () => {
  it("says nothing when today's file already landed", () => {
    const result = describeImportStaleness(
      plantTime(2026, 8, 11, 6),
      plantTime(2026, 8, 11, 9),
    );
    expect(result.level).toBe("ok");
    expect(result.message).toBeNull();
    expect(result.daysSince).toBe(0);
  });

  it("stays quiet at one and two days", () => {
    for (const day of [10, 9]) {
      const result = describeImportStaleness(
        plantTime(2026, 8, day, 6),
        plantTime(2026, 8, 11, 9),
      );
      expect(result.level).toBe("ok");
      expect(result.message).toBeNull();
    }
  });

  it("stays quiet on Monday morning after a Friday upload - the case N=3 exists for", () => {
    // 2026-08-07 is a Friday, 2026-08-10 the following Monday. HR publishes weekend
    // reports but they are normally uploaded together on Monday (D-209), so a 3-day gap
    // here is the healthy pipeline and must not shout.
    const friday = plantTime(2026, 8, 7, 6);
    const mondayMorning = plantTime(2026, 8, 10, 9);
    const result = describeImportStaleness(friday, mondayMorning);
    expect(result.daysSince).toBe(3);
    // 3 is the threshold, so this is the ONE boundary the whole constant turns on: at
    // exactly N days the banner appears. Monday 09:00 after a Friday 06:00 upload is
    // therefore the first moment it fires - one day earlier and every Monday shouts.
    expect(result.level).toBe("stale");
  });
});

describe("describeImportStaleness - the threshold boundary", () => {
  const now = plantTime(2026, 8, 11, 9);

  it("fires at exactly the threshold and not one day before", () => {
    const twoDays = describeImportStaleness(plantTime(2026, 8, 9, 6), now);
    const threeDays = describeImportStaleness(plantTime(2026, 8, 8, 6), now);
    expect(twoDays.level).toBe("ok");
    expect(threeDays.level).toBe("stale");
    expect(threeDays.daysSince).toBe(3);
  });

  it("counts dates turning over, not elapsed hours", () => {
    // 2026-08-08 23:50 to 2026-08-11 00:10 is barely over 48 hours, but three dates have
    // turned over. Counting hours would call this 2 days and stay silent; counting dates
    // calls it 3 and warns. The date count is what an operator means by "没有导入".
    const result = describeImportStaleness(
      plantTime(2026, 8, 8, 23, 50),
      plantTime(2026, 8, 11, 0, 10),
    );
    expect(result.daysSince).toBe(3);
    expect(result.level).toBe("stale");
  });

  it("does not let a late-evening upload buy an extra day", () => {
    // The mirror of the case above: 2026-08-10 23:50 to 2026-08-11 00:10 is 20 minutes,
    // one date turnover. A naive hour count would round to 0 and both agree here - the
    // assertion pins that the projection has not shifted the cheap case either.
    const result = describeImportStaleness(
      plantTime(2026, 8, 10, 23, 50),
      plantTime(2026, 8, 11, 0, 10),
    );
    expect(result.daysSince).toBe(1);
    expect(result.level).toBe("ok");
  });

  it("respects an explicit threshold over the default", () => {
    const at = plantTime(2026, 8, 6, 6);
    const now5 = plantTime(2026, 8, 11, 9);
    expect(describeImportStaleness(at, now5, 5).level).toBe("stale");
    expect(describeImportStaleness(at, now5, 6).level).toBe("ok");
  });

  it("defaults to 3 days", () => {
    expect(DEFAULT_STALENESS_THRESHOLD_DAYS).toBe(3);
  });
});

describe("describeImportStaleness - stale data", () => {
  it("quotes the day count and the threshold so the number is checkable", () => {
    const result = describeImportStaleness(
      plantTime(2026, 8, 4, 6),
      plantTime(2026, 8, 11, 9),
    );
    expect(result.level).toBe("stale");
    expect(result.daysSince).toBe(7);
    expect(result.message).toContain("7");
    expect(result.message).toContain("3");
  });

  it("tells the operator the figures below may be short, not that they are wrong", () => {
    // The stored numbers are correct for the days that DID import. Saying the data is
    // wrong would invite someone to discard a valid report.
    const message = describeImportStaleness(
      plantTime(2026, 8, 1, 6),
      plantTime(2026, 8, 11, 9),
    ).message;
    expect(message).toContain("可能缺少");
  });
});

describe("describeImportStaleness - never imported", () => {
  it("is its own level, not an enormous day count", () => {
    // "从未导入" and "10 天没导入" have different fixes - start uploading versus find out
    // why the uploads stopped - so they get different levels rather than one number that
    // happens to be large.
    const result = describeImportStaleness(null, plantTime(2026, 8, 11, 9));
    expect(result.level).toBe("never");
    expect(result.daysSince).toBeNull();
    expect(result.message).toContain("从未成功导入");
  });
});

describe("describeImportStaleness - bad inputs", () => {
  const now = plantTime(2026, 8, 11, 9);

  it("clamps a future timestamp to 0 instead of reporting negative days", () => {
    // Clock skew between the browser and the server, or a bad stored value. Neither is
    // freshness, but neither is staleness either - and "已连续 -2 天" would be nonsense.
    const result = describeImportStaleness(plantTime(2026, 8, 13, 6), now);
    expect(result.level).toBe("ok");
    expect(result.daysSince).toBe(0);
  });

  it("treats an unparseable stored timestamp as a reason to look at the log", () => {
    // Silently calling a corrupt timestamp "fresh" would hide two problems at once.
    const result = describeImportStaleness(new Date(Number.NaN), now);
    expect(result.level).toBe("stale");
    expect(result.daysSince).toBeNull();
    expect(result.message).toContain("无法解析");
  });

  it("throws on an unparseable now - there is no defensible answer", () => {
    expect(() => describeImportStaleness(plantTime(2026, 8, 1, 6), new Date(Number.NaN))).toThrow(
      /now/i,
    );
  });

  it("throws on a non-positive or fractional threshold", () => {
    const at = plantTime(2026, 8, 1, 6);
    expect(() => describeImportStaleness(at, now, 0)).toThrow();
    expect(() => describeImportStaleness(at, now, -1)).toThrow();
    expect(() => describeImportStaleness(at, now, 2.5)).toThrow();
  });
});

describe("describeImportStaleness - timezone independence", () => {
  it("judges by plant-local dates regardless of the host clock", () => {
    // BUSINESS_TIME_ZONE is hard-coded to Asia/Shanghai, so a TZ=UTC process must reach
    // the same verdict. 2026-08-08 01:00 plant-local is 2026-08-07 17:00 UTC: a host-local
    // day count would read this as one date earlier and flip the boundary below.
    const result = describeImportStaleness(
      plantTime(2026, 8, 8, 1),
      plantTime(2026, 8, 11, 1),
    );
    expect(result.daysSince).toBe(3);
    expect(result.level).toBe("stale");
  });
});
