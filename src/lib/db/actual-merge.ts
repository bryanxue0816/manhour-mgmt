// Folding adjustment slips into actual rows (D-233).
//
// Deliberately Prisma-free, same rationale as actual-source.ts and hours.ts: this is the
// arithmetic that decides what every 实绩 figure on screen actually says, and it must be
// testable without a database standing behind it.
//
// FOUR TRAPS THIS MODULE EXISTS TO CLOSE. Each was measured in the existing read path,
// and each fails silently:
//
// 1. THE ROW SET IS A UNION, NOT `Actual` ALONE. A section-month may hold an adjustment
//    and no folded row at all - that is precisely 8月's shape for a section whose 1-25
//    hours arrived as a 課 total while its 26-31 detail was never imported, and it is the
//    normal shape for any pre-go-live month. Iterating `Actual` and looking adjustments up
//    would drop those rows entirely: no error, just a section missing from the total.
//
// 2. THE OUTPUT MUST HOLD ONE ROW PER (section, month). buildOrgRoot() does
//    `slot.actual = row.totalHours` - ASSIGNMENT, not `+=`. Returning two rows for one
//    section-month would make the second silently overwrite the first, so the collapse has
//    to happen here, before any consumer sees the data.
//
// 3. REVOKED SLIPS MUST NOT COUNT. The repo already filters them in SQL, and this module
//    filters them AGAIN rather than trusting that. Not redundancy for its own sake: the
//    input type carries `revokedAt`, so a caller that hands over an unfiltered list is
//    making a reasonable-looking call, and the consequence - revoked hours quietly back in
//    the company total - is invisible on screen.
//
// 4. A SLIP CAN OUTLIVE THE BASE IT WAS WRITTEN AGAINST. 8月 is a `fold` month, so
//    rebuildMonthlyActuals()'s D-198 guard - which refuses `manual` months only - lets it
//    be re-folded at any time, and nothing in the scheduled fetch or /actuals/import
//    filters by date. Detail arriving late lifts `totalHours` while the hand-tallied slips
//    keep adding on top, roughly doubling the month with no error and no log. Each slip
//    therefore carries the base it was entered against, and a mismatch raises
//    `foldChangedSinceAdjustment` for a human to judge. NOTHING is auto-corrected: the
//    module cannot tell double-counting from a legitimate re-fold.

import { ACTUAL_SOURCE_FOLD } from "./actual-source";
import { assertFiniteHours } from "./hours";
import type { ActualAdjustmentRow, ActualEffectiveRow, ActualRow } from "./types";

/**
 * Index key for one section-month.
 *
 * Includes `fiscalYearId` because (sectionId, month) is NOT unique across the table - the
 * same trap PlanRow.fiscalYearId documents. Callers pass a single year today, but a key
 * that omitted the year would make a future cross-year call ADD two years together and
 * report the sum as one month.
 *
 * "|" as the separator: cuid() emits only lowercase letters and digits, so no combination
 * of ids can collide by straddling the boundary. A control character such as NUL would
 * separate just as safely, but embedding one in the source makes the file non-text to git
 * and grep - a real cost for no extra guarantee.
 */
function keyOf(fiscalYearId: string, sectionId: string, month: number): string {
  return `${fiscalYearId}|${sectionId}|${month}`;
}

/**
 * How far the folded base may move before a slip is called stale, in hours.
 *
 * Both sides of the comparison are values this system stored itself, so exact equality
 * would work for every figure it produces today. The tolerance is here because the two
 * sides took DIFFERENT arithmetic routes to get there: `foldHoursAtEntry` is one REAL read
 * straight back out of the row, while `totalHours` is re-derived by summing per-person
 * quarter-hours across a month, and a re-fold of unchanged detail can land a few ulps away
 * from the first fold. 0.05 is half the 0.1 precision the source data actually carries, so
 * it cannot mask a real edit while it does absorb float noise.
 *
 * NOT exported and NOT reused as a general epsilon: hours.ts deliberately offers no
 * tolerance helper, because every other comparison in this layer is against a threshold a
 * human chose, where silently accepting "close enough" is the wrong behaviour.
 */
const FOLD_DRIFT_TOLERANCE_HOURS = 0.05;

/**
 * Did the folded base move since this slip was written?
 *
 * False for a null `foldHoursAtEntry` - null means the base was never recorded, so there
 * is nothing to compare. Treating "unknown" as "changed" would light the warning on every
 * hand-inserted row forever, which trains the operator to ignore it and costs the check
 * its only value.
 *
 * A non-finite stored snapshot compares unequal and therefore FLAGS rather than throws,
 * unlike effectiveHours below. That is the safe direction: this value enters no total, so
 * it can poison nothing, and a garbage snapshot is itself a reason to look at the row.
 */
function foldDrifted(slip: ActualAdjustmentRow, currentFold: number): boolean {
  if (slip.foldHoursAtEntry === null) {
    return false;
  }
  // Negated `<=`, NOT `>`: with NaN on either side every comparison is false, so `>` would
  // report "no drift" for a corrupt snapshot. This form reports drift instead.
  return (
    !(Math.abs(currentFold - slip.foldHoursAtEntry) <= FOLD_DRIFT_TOLERANCE_HOURS)
  );
}

/**
 * A section-month that has adjustments but no folded row.
 *
 * `source` is "fold" and the three hour columns are 0, and NO third source value was
 * introduced for this case. "That section folded 0 hours that month" is a true statement
 * about the attendance detail, and it is what the screen should say. Inventing a
 * `"virtual"` marker would have to be added to ACTUAL_SOURCES, which is the vocabulary
 * three separate `source` queries filter on - including rebuildMonthlyActuals()'s guard,
 * which must keep answering "not manual" for these rows so a real import can still fold
 * the month.
 */
function virtualRow(
  fiscalYearId: string,
  sectionId: string,
  month: number,
): ActualEffectiveRow {
  return {
    sectionId,
    fiscalYearId,
    month,
    personnelHours: 0,
    overtimeHours: 0,
    totalHours: 0,
    source: ACTUAL_SOURCE_FOLD,
    adjustmentHours: 0,
    effectiveHours: 0,
    foldChangedSinceAdjustment: false,
  };
}

/**
 * Folds adjustment slips into actual rows, one row per (fiscalYearId, sectionId, month).
 *
 * `totalHours` is returned UNCHANGED - it stays the folded figure and stays equal to
 * personnelHours + overtimeHours. The adjustment lands in `adjustmentHours`, and
 * `effectiveHours` is their sum. See ActualEffectiveRow for why blending was rejected.
 *
 * Revoked slips (`revokedAt !== null`) are skipped. A section-month whose slips are all
 * revoked still yields its row - with `adjustmentHours` at 0 - if it had a folded row to
 * begin with; it does NOT materialise a virtual row, because there is nothing left to
 * report about it.
 *
 * Output order is (sectionId, month) ascending, matching findActualsByFiscalYear()'s
 * `orderBy` so fixtures and diffs stay reproducible whether or not adjustments exist.
 *
 * @throws if any resulting `effectiveHours` is not finite. Deliberately loud: an Infinity
 *   here propagates through the roll-up into the DEPARTMENT and COMPANY totals while
 *   healthy sibling sections still render correctly (see hours.ts for the measured
 *   chain), and a blown-out total over intact detail rows is materially harder to
 *   attribute than a page that refuses to load.
 */
export function mergeActualAdjustments(
  actuals: readonly ActualRow[],
  adjustments: readonly ActualAdjustmentRow[],
): ActualEffectiveRow[] {
  const merged = new Map<string, ActualEffectiveRow>();

  for (const row of actuals) {
    merged.set(keyOf(row.fiscalYearId, row.sectionId, row.month), {
      ...row,
      adjustmentHours: 0,
      effectiveHours: row.totalHours,
      foldChangedSinceAdjustment: false,
    });
  }

  for (const slip of adjustments) {
    if (slip.revokedAt !== null) {
      continue;
    }
    const key = keyOf(slip.fiscalYearId, slip.sectionId, slip.month);
    const target =
      merged.get(key) ?? virtualRow(slip.fiscalYearId, slip.sectionId, slip.month);
    // Accumulate: one section-month legitimately carries several slips from unrelated
    // events (8月's go-live back-fill and an October discrepancy are two facts), which is
    // why the table has no unique key on (sectionId, fiscalYearId, month).
    const adjustmentHours = target.adjustmentHours + slip.hours;
    merged.set(key, {
      ...target,
      adjustmentHours,
      effectiveHours: target.totalHours + adjustmentHours,
      // OR across the slips, never reset: one stale slip is enough to make the section-month
      // total suspect, and a later slip entered against the CURRENT base does not vindicate
      // the earlier one - both sets of hours are still in `adjustmentHours`.
      foldChangedSinceAdjustment:
        target.foldChangedSinceAdjustment || foldDrifted(slip, target.totalHours),
    });
  }

  const rows = [...merged.values()];
  for (const row of rows) {
    assertFiniteHours("effectiveHours", row.effectiveHours);
  }
  rows.sort(
    (left, right) =>
      left.sectionId.localeCompare(right.sectionId) || left.month - right.month,
  );
  return rows;
}

/**
 * Fiscal months (1 = April) carrying at least one un-revoked adjustment.
 *
 * The footnote counterpart to findManualBaselineMonthsByFiscalYear(): the 实绩 screen has
 * to be able to caption which months hold hours that no attendance detail backs, and a
 * hard-coded 「8月」 becomes wrong the first time a discrepancy is corrected in October.
 */
export function adjustedMonths(
  adjustments: readonly ActualAdjustmentRow[],
): readonly number[] {
  const months = new Set<number>();
  for (const slip of adjustments) {
    if (slip.revokedAt === null) {
      months.add(slip.month);
    }
  }
  return [...months].sort((left, right) => left - right);
}
