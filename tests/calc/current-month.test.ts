// D-165 acceptance: the dashboard's month anchor is derived from data, not from a constant.
//
// The bug this guards against produced no error. With the anchor hard-coded at index 2 and
// the only imported month sitting at index 3, every KPI read `0 H`, budget usage read `0%`,
// and all seven departments read 「达成」 - a dashboard that looks healthy while showing
// nothing. There is no crash and no red pixel to notice, so the only thing that can catch a
// regression here is an assertion on the index itself.
//
// `resolveCurrentMonthIdx` is deliberately dependency-free (no Prisma, no React), which is
// what lets these run without DATABASE_URL.

import { describe, expect, it } from "vitest";

import { resolveCurrentMonthIdx } from "@/lib/current-month";
import { CUR_MONTH_IDX, type MonthlyHours } from "@/types/manhour";

/**
 * Build a 12-month series whose `actual` values are taken from `actuals` (missing
 * trailing entries default to 0). `plan`/`challenge` are non-zero throughout, so a
 * test that accidentally anchored on plan hours instead of actuals would pass on
 * every month and be visible as a wrong index rather than as a coincidence.
 */
function months(actuals: readonly number[]): MonthlyHours[] {
  return Array.from({ length: 12 }, (_unused, i) => ({
    plan: 3000,
    challenge: 2900,
    actual: actuals[i] ?? 0,
  }));
}

describe("resolveCurrentMonthIdx", () => {
  it("falls back when no month has actual hours", () => {
    // The mock's steady state, and also a freshly seeded database with plans but no
    // imports. Falling back rather than anchoring at 0 matters because the mock's
    // hand-tuned current-month ratios only make sense at their designed index.
    expect(resolveCurrentMonthIdx(months([]), CUR_MONTH_IDX)).toBe(CUR_MONTH_IDX);
  });

  it("anchors on the only month that has data", () => {
    // The real FY2026 state at the time of D-165: one imported month at index 3
    // (fiscal month 4 = 26/07), total 4631.5 company-wide.
    expect(resolveCurrentMonthIdx(months([0, 0, 0, 4631.5]), CUR_MONTH_IDX)).toBe(3);
  });

  it("anchors on the LAST month with data, not the first", () => {
    // Scanning forwards would stop at index 0 and under-report the cumulative folds
    // by three months.
    expect(resolveCurrentMonthIdx(months([100, 200, 300, 400]), CUR_MONTH_IDX)).toBe(3);
  });

  it("ignores zeroed months that follow the last real one", () => {
    // A partially filled fiscal year: months 5..12 exist as prefilled zero slots
    // (org-tree.ts always emits a dense 12) and must not be mistaken for data.
    const series = months([100, 200, 300]);
    expect(resolveCurrentMonthIdx(series, CUR_MONTH_IDX)).toBe(2);
    expect(series[11]!.actual).toBe(0); // the zero slots really are there
  });

  it("treats a negative month total as data, not as empty", () => {
    // Overtime may be negative when 调休 exceeds 加班 (D-105), so a section - or a
    // whole company in a light month - can net below zero. A `> 0` test would skip
    // such a month and silently anchor the dashboard one month earlier.
    expect(resolveCurrentMonthIdx(months([100, 200, -50]), CUR_MONTH_IDX)).toBe(2);
  });

  it("clamps an out-of-range fallback into the array", () => {
    // Guards the caller that passes the mock's CUR_MONTH_IDX against a shorter
    // series; an unclamped return would index past the end and crash on property
    // access downstream.
    expect(resolveCurrentMonthIdx(months([]).slice(0, 2), 99)).toBe(1);
    expect(resolveCurrentMonthIdx(months([]).slice(0, 2), -5)).toBe(0);
  });

  it("returns 0 for an empty series", () => {
    // Not a valid index, but neither is anything else. Documented so a caller
    // reading the result knows an empty series yields 0 rather than -1.
    expect(resolveCurrentMonthIdx([], CUR_MONTH_IDX)).toBe(0);
  });
});
