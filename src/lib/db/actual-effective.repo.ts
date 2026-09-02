// The read that answers "what were the actual hours?" as D-141 defines 实绩 (D-233).
//
// A composition, not a table of its own: it reads `actual` and `actual_adjustment` and
// hands both to mergeActualAdjustments(). Deliberately its own file rather than a function
// in actual.repo.ts, whose stated scope is one table and flat rows, and rather than one in
// actual-merge.ts, which is Prisma-free precisely so the arithmetic stays testable without
// a database.
//
// EVERY SCREEN THAT REPORTS 实绩 SHOULD READ THROUGH HERE. findActualsByFiscalYear() still
// returns the plain fold, which is the right answer for the attendance-provenance panels
// (what did the import itself produce?) and the wrong one for a total a manager reads.

import { prisma } from "@/lib/prisma";
import { findActiveAdjustmentsByFiscalYear } from "./actual-adjustment.repo";
import { adjustedMonths, mergeActualAdjustments } from "./actual-merge";
import { findActualsByFiscalYear } from "./actual.repo";
import type { ActualEffectiveRow } from "./types";

export interface EffectiveActuals {
  /** One row per (section, month) that has a folded row, a slip, or both. */
  rows: readonly ActualEffectiveRow[];
  /**
   * Fiscal months carrying at least one un-revoked slip, ascending.
   *
   * Derived from the SLIPS, not from `adjustmentHours !== 0` on the merged rows, and the
   * difference is not academic: a section-month holding +300 and -300 un-revoked nets to
   * zero, so a sum-driven test would report the month as untouched while two slips are
   * live on it. The footnote has to name it either way - the figures on screen came from
   * a hand tally, and that is the caption's whole point.
   */
  adjustedMonths: readonly number[];
}

/**
 * Folded rows merged with un-revoked adjustment slips for one fiscal year.
 *
 * Both reads share ONE transaction, the same reasoning as loadOrgSnapshot(): the merge
 * compares each slip's recorded `foldHoursAtEntry` against the `totalHours` it reads here,
 * so two independent queries with a scheduled re-fold (09:05 / 15:05) landing between them
 * would compare figures from different instants and raise a drift warning for a
 * section-month that never drifted. A false alarm on this banner is expensive in a way a
 * missing one is not: it teaches the operator to dismiss it.
 *
 * Interactive form rather than `$transaction([...])`: the array form needs the queries
 * built inline, which would duplicate both repositories' select shapes and row mappers
 * here - the exact duplication the repository layer exists to prevent. Two indexed reads
 * of a few hundred rows do not need the round-trip saving.
 *
 * The merge runs OUTSIDE the callback so the transaction holds nothing but IO. It throws on
 * a non-finite `effectiveHours` (see actual-merge.ts), and a throw inside the callback would
 * present a pure-arithmetic fault as a database rollback in the logs.
 *
 * @throws if any resulting `effectiveHours` is not finite - see mergeActualAdjustments.
 */
export async function findEffectiveActualsByFiscalYear(
  fiscalYearId: string,
): Promise<EffectiveActuals> {
  const [actuals, adjustments] = await prisma.$transaction(async (tx) => {
    const folded = await findActualsByFiscalYear(fiscalYearId, tx);
    const slips = await findActiveAdjustmentsByFiscalYear(fiscalYearId, tx);
    return [folded, slips] as const;
  });

  return {
    rows: mergeActualAdjustments(actuals, adjustments),
    adjustedMonths: adjustedMonths(adjustments),
  };
}
