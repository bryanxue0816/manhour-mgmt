// The last hop of the 财务课 26/08 incident: from a month total to the cumulative folds.
//
// THIS IS A REGRESSION LOCK, NOT A DEFECT TEST. calc.ts was never wrong - it faithfully
// folded whatever `month.actual` held, and the bug was upstream in the adapter, which put
// the raw fold there instead of 折算 + 未撤销调整单. These assertions passed before that fix
// and pass after it.
//
// They exist because the fix was justified by a claim that had no test behind it: that
// correcting ONE field (slot.actual) moves 単月実績, 累計実績, 累計残 and the KPI cards
// together, because every one of them folds this same array. That claim is what makes a
// one-line change an acceptable answer to a five-number discrepancy, and until now it
// rested on reading calc.ts rather than on running it. If someone later gives 累計 its own
// data path - reading totalHours again, or summing adjustments separately - the dashboard
// splits back into two disagreeing numbers and nothing here would have objected.
//
// Pure functions over plain arrays: no Prisma, no DATABASE_URL, no React.

import { describe, expect, it } from "vitest";

import { computeChartData, computeKpi, cumToCurrent } from "@/lib/calc";
import type { MonthAxis, MonthlyHours } from "@/types/manhour";

/** Fiscal month 1 is April, so 26/08 is fiscal month 5 - array index 4. */
const AUG_IDX = 4;

const AXIS: MonthAxis = {
  curIdx: AUG_IDX,
  labels: ["26/04", "26/05", "26/06", "26/07", "26/08", "26/09",
           "26/10", "26/11", "26/12", "27/01", "27/02", "27/03"],
};

/**
 * The 財務課 series as the 看板 tooltip actually reported it, with 26/08's actual left
 * open so both sides of the incident can be built from one fixture.
 *
 * Reported: 累计实绩 5,152.5 / 累计挑战 4,980 / 累计计划 5,224, and for 26/08 alone
 * 计划 1,045 / 挑战 996 / 实绩 1,072. That fixes the 26/04-26/07 prefix totals by
 * subtraction (actual 4,080.5, plan 4,179, challenge 3,984) but says nothing about how
 * each splits across those four months - so the prefix is carried in ONE slot rather than
 * spread over four invented ones. A cumulative fold cannot tell the difference, and a
 * fixture should not imply four measurements that were never taken.
 */
function zaimu(augActual: number): MonthlyHours[] {
  const months: MonthlyHours[] = Array.from({ length: 12 }, () => ({
    plan: 0, challenge: 0, actual: 0,
  }));
  months[0] = { plan: 4179, challenge: 3984, actual: 4080.5 };
  months[AUG_IDX] = { plan: 1045, challenge: 996, actual: augActual };
  return months;
}

/** The number the 看板 showed while /actuals already showed 1,073. */
const BEFORE = zaimu(1072);
/** The same section once the +1 adjustment slip is read instead of skipped. */
const AFTER = zaimu(1073);

describe("adjusted month totals reaching the cumulative folds", () => {
  it("reproduces the reported cumulative before the fix", () => {
    // Anchors the fixture to the incident report rather than to a number of our own
    // choosing: if this drifts, the rest of the file is measuring something else.
    expect(cumToCurrent(BEFORE.map((m) => m.actual), AXIS)).toBe(5152.5);
  });

  it("carries a +1 adjustment into 累计实绩", () => {
    // 5,152.5 -> 5,153.5, which is the production predicate for the deployment. Asserted
    // as an absolute value, not a delta, because a fold that dropped the prefix entirely
    // would still show a +1 difference between the two runs.
    expect(cumToCurrent(AFTER.map((m) => m.actual), AXIS)).toBe(5153.5);
  });

  it("moves 単月 and 累計 in the same KPI computation", () => {
    // The heart of the one-line justification. A fix that reached only one of these is
    // exactly how the incident was reported: /actuals right, 看板 wrong, same data.
    const before = computeKpi(BEFORE, "財務課", AXIS);
    const after = computeKpi(AFTER, "財務課", AXIS);

    expect(before.monthActual).toBe(1072);
    expect(after.monthActual).toBe(1073);
    expect(before.cumActual).toBe(5152.5);
    expect(after.cumActual).toBe(5153.5);
  });

  it("decreases 累計残 by the adjustment", () => {
    // cumRemain = cumPlan - cumActual, so an under-read actual OVERSTATES the remaining
    // budget - the direction that lets a section quietly overrun. Plans are untouched by
    // adjustment slips, so the whole movement must land on the actual side.
    const before = computeKpi(BEFORE, "財務課", AXIS);
    const after = computeKpi(AFTER, "財務課", AXIS);

    expect(before.cumPlan).toBe(5224);
    expect(after.cumPlan).toBe(5224);
    expect(before.cumRemain).toBe(5224 - 5152.5);
    expect(after.cumRemain).toBe(before.cumRemain - 1);
  });

  it("carries the adjustment into every later month of the chart's cumulative series", () => {
    // The combo chart uses cumFull(), a running total, so an adjustment in 26/08 must
    // persist through 27/03 rather than showing up as a one-month blip. Months after the
    // anchor are zero-filled here, which is what org-tree.ts emits for an unimported
    // month, so the series should stay flat at the raised value.
    const before = computeChartData(BEFORE, AXIS);
    const after = computeChartData(AFTER, AXIS);

    expect(before[AUG_IDX]!.cumActual).toBe(5152.5);
    expect(after[AUG_IDX]!.cumActual).toBe(5153.5);
    expect(after[11]!.cumActual).toBe(5153.5);
    // And months BEFORE the adjustment are untouched: a slip is not retroactive.
    expect(after[3]!.cumActual).toBe(before[3]!.cumActual);
  });

  it("leaves 挑战 and 计划 alone", () => {
    // An adjustment slip is a correction to measured hours, never to a target. If a
    // future change folds adjustments into the wrong series, the achievement table
    // starts reporting 达成 against a moved goalpost.
    const after = computeKpi(AFTER, "財務課", AXIS);
    expect(after.monthPlan).toBe(1045);
    expect(after.monthChallenge).toBe(996);
    expect(cumToCurrent(AFTER.map((m) => m.challenge), AXIS)).toBe(4980);
  });
});
