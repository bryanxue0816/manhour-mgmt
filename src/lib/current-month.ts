/**
 * Resolving "the current month" from data rather than from the calendar.
 *
 * The dashboard's KPI cards, achievement tables and budget gauge all fold over
 * months[0..cur]. Everything therefore hinges on which index `cur` is, and the
 * original mock hard-coded it as `CUR_MONTH_IDX = 2`.
 *
 * That constant is wrong in two independent ways once real data arrives:
 *
 *   1. It is not today. Today (2026-08-07) is fiscal month 5, index 4.
 *   2. It is not where the data is. The attendance import has produced exactly
 *      one month, fiscal month 4 = index 3.
 *
 * Neither of those is a crash. Anchoring at index 2 makes every figure read
 * `0 H` / `0%` / `达成`, which is a dashboard that looks healthy while showing
 * nothing - strictly more dangerous than an error page, because nobody
 * investigates a green screen.
 *
 * Today's calendar month is also the wrong anchor, for the same reason it was
 * rejected for the /actuals focus month (D-164): the calendar month and the last
 * imported month are routinely different, and August has no data at all. So the
 * anchor is derived from the data - the newest month that actually has actual
 * hours.
 *
 * Deliberately dependency-free (no Prisma, no React, no date library) so the
 * rules below are unit-testable in isolation.
 */

import type { MonthlyHours } from "@/types/manhour";

/**
 * Index of the newest month that has actual hours, or `fallbackIdx` when none does.
 *
 * The "has data" test is `actual !== 0`, NOT `actual > 0`. Overtime hours may be
 * negative when 调休 exceeds 加班 (D-105), so a section's month total can legitimately
 * be negative, and `> 0` would skip such a month and silently anchor the whole
 * dashboard one month earlier.
 *
 * A stored `0` is indistinguishable from "never imported" at this level, and that is
 * accepted here: unlike the /actuals grid - which has `present` from the repository
 * layer to tell the two apart (D-164) - the org tree carries no such flag, and a
 * company-wide total of exactly 0 for a month that WAS imported would require every
 * one of 24 sections to net to zero. Treating it as "no data" is the safe reading:
 * it anchors one month earlier rather than reporting 0% usage as fact.
 *
 * Scans backwards and returns on the first hit, so a partially-filled fiscal year
 * anchors on its last real month rather than on a later zeroed slot.
 *
 * @param months     Any node's monthly series. Length is not assumed to be 12.
 * @param fallbackIdx Index to use when no month has data. Clamped into range, so a
 *   caller passing the mock's `CUR_MONTH_IDX` against a shorter array cannot produce
 *   an out-of-range anchor.
 * @returns A valid index into `months`, or 0 when `months` is empty.
 */
export function resolveCurrentMonthIdx(
  months: readonly MonthlyHours[],
  fallbackIdx: number,
): number {
  for (let i = months.length - 1; i >= 0; i -= 1) {
    if (months[i]!.actual !== 0) return i;
  }
  // No data anywhere. This is the mock's steady state (its hand-tuned
  // current-month ratios only make sense at their designed index) and also a
  // freshly seeded database with plans but no imports yet.
  if (months.length === 0) return 0;
  return Math.max(0, Math.min(fallbackIdx, months.length - 1));
}
