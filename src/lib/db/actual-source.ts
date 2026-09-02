// Actual-row provenance vocabulary. Prisma-free by design.
//
// Same rationale as import-status.ts: lib/prisma.ts constructs the client at module load,
// so importing a repository drags better-sqlite3 and DATABASE_URL into scope. This
// vocabulary needs to be unit-testable on its own because it is the only guard between a
// typo and a third silent provenance value in a column that the rebuild guard reads.
//
// SQLite has no enum, so actual.source is a TEXT column and this file IS the constraint.
// [PG] becomes a real enum and these asserts become belt-and-braces.

/** The only two legal values of `actual.source` (D-198). */
export const ACTUAL_SOURCES = ["fold", "manual"] as const;

export type ActualSource = (typeof ACTUAL_SOURCES)[number];

/**
 * The two values as named constants.
 *
 * Three separate queries filter on `source`: the rebuild guard, the audit snapshot, and the
 * baseline import. A misspelled literal in any of them is neither a type error nor a
 * runtime error - it simply matches nothing, so the guard stops guarding while still
 * reading as correct. Referencing these makes that same typo fail to compile.
 */
export const ACTUAL_SOURCE_FOLD: ActualSource = "fold";
export const ACTUAL_SOURCE_MANUAL: ActualSource = "manual";

/** Human-facing labels, used by the actuals page and the dashboard footnote. */
export const ACTUAL_SOURCE_LABELS: Record<ActualSource, string> = {
  fold: "考勤折算",
  manual: "手工基线",
};

/**
 * Narrows a stored string to ActualSource, throwing on anything outside the vocabulary.
 *
 * Compared VERBATIM - no trim, no case folding. `" manual"` and `"Manual"` are both
 * rejected on purpose: accepting them would let two spellings of one provenance coexist,
 * and the rebuild guard's `source === "manual"` test would quietly miss half the rows -
 * which is exactly the failure that silently zeroes a hand-typed baseline.
 */
export function assertActualSource(value: string): ActualSource {
  const found = ACTUAL_SOURCES.find((s) => s === value);
  if (found === undefined) {
    throw new Error(
      `actual.source 非法值：${JSON.stringify(value)}。` +
        `允许值：${ACTUAL_SOURCES.join(" / ")}。`,
    );
  }
  return found;
}

/** True when the row was typed in by hand and must never be recomputed from attendance. */
export function isManualBaseline(value: string): boolean {
  return assertActualSource(value) === "manual";
}
