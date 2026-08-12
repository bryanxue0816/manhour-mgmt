// Validation for hour quantities crossing the persistence boundary.
//
// Kept separate from date.ts, which owns the fiscal-calendar domain: this module is
// purely about the numeric columns (plannedHours, challengeHours, personnelHours,
// overtimeHours, totalHours).
//
// Why this exists at all - the asymmetry it removes:
//
// `month` has been guarded by assertFiscalMonth() at every write since Phase 2, but
// the hour columns had no guard, even though they fail in a strictly worse way. The
// measured chain:
//
//   work_calendar not seeded for a range
//     -> countWorkingDays() returns 0
//     -> a prorating divide yields Infinity
//     -> SQLite ACCEPTS Infinity into a REAL NOT NULL column (stored as typeof
//        'real'), and BOTH better-sqlite3 and Prisma read it back as Infinity -
//        not NULL
//     -> buildOrgRoot() does `slot.actual = row.totalHours` -> Infinity
//     -> the roll-up does `target.actual += Infinity`, so the section's DEPARTMENT
//        total and the ROOT total both become Infinity, while healthy sibling
//        sections in the same department still show correct numbers
//     -> the dashboard shows blown-out totals over intact detail rows, which is
//        materially harder to attribute than a single wrong cell.
//
// CAUTION when re-checking the above: `JSON.stringify(Infinity)` is the string
// "null", so logging a read-back row with JSON.stringify makes a poisoned Float
// column look like a NULL. Compare with `Number.isFinite` or print via `String()`.
// An earlier version of this comment claimed the value came back as NULL and that
// the roll-up degraded to `+= 0`; both were artefacts of exactly that mistake.
//
// NaN does fail loudly here - SQLite rejects it with SQLITE_CONSTRAINT_NOTNULL,
// since it arrives as NULL - but relying on that is relying on an implementation
// detail of one database, and it covers only NaN, never Infinity. On PostgreSQL
// `double precision` supports Infinity natively, so even the NaN backstop is gone
// and non-finite values persist silently.
//
// DELIBERATELY NOT CLAMPED: `overtimeHours` is legally negative (D-105 - deductions
// can exceed additions), so a total below zero is real data. A `Math.max(0, ...)`
// here would silently rewrite anomalous imports into plausible ones, which is the
// exact failure mode this module exists to prevent.

/**
 * Asserts an hour quantity is a finite number.
 *
 * Rejects NaN, Infinity and -Infinity. Negative finite values PASS - see the
 * clamping note above.
 *
 * @param field column name, so the message identifies which value was bad.
 * @param value the quantity to check.
 * @throws if `value` is not finite.
 */
export function assertFiniteHours(field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid ${field}: ${value} (expected a finite number). ` +
        "Infinity persists to the database and poisons every roll-up that sums it; " +
        "NaN is rejected only by SQLite's NOT NULL, not by PostgreSQL.",
    );
  }
}
