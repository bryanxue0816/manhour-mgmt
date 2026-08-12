// Adapter: flat database rows -> the nested OrgRoot the dashboard already consumes.
//
// This file is the ONLY place where the two month-numbering schemes meet:
//
//   input  (database) : month 1..12, where 1 = April
//   output (frontend) : months[0..11], where index 0 = April
//
// Everything upstream stays 1-based; everything downstream stays 0-based.
//
// FIVE INVARIANTS. Each was derived from existing behaviour in lib/calc.ts and
// components/tree/OrgTree.tsx, and violating any of them produces *silently
// wrong numbers* rather than a crash - which is why each is enforced here
// explicitly rather than left to the shape of the query results.
//
//   1. DENSE, ALWAYS-12 months
//      computeMonthlyRows() and the cumulative folds in calc.ts walk the whole
//      array. A sparse array (holes from missing months) makes `undefined`
//      leak into arithmetic and yields NaN cumulatives. We therefore prefill
//      all 12 slots with zeros and *overwrite* by index.
//
//   2. STABLE ORDER, sorted by (sortOrder, name)
//      DrillState addresses nodes by ARRAY INDEX (deptIdx / secIdx), and
//      calc.ts#requireDept / #requireSection THROW on out-of-range. The second
//      sort key matters: duplicate sortOrder values would otherwise let the
//      order drift between requests, silently repointing a bookmarked drill
//      state at a different department.
//
//   3. ZERO-SECTION DEPARTMENTS ARE KEPT
//      Dropping a childless department would shift every later department's
//      index down by one. It is emitted with 12 zeroed months instead.
//
//   4. MONTH-WISE ROLL-UP
//      dept.months[i] = sum of its sections' months[i]
//      root.months[i] = sum of all departments' months[i]
//      Computed per month, never as a single total spread back across months.
//
//   5. SINGLE FISCAL YEAR PER BUILD
//      Slots are keyed by (sectionId, month) and ASSIGNED, not accumulated - see
//      groupMonthsBySection(). Two fiscal years in one call therefore collide on
//      every key and the later row wins, with no error. Enforced by
//      assertSingleFiscalYear().

import type { Dept, MonthlyHours, OrgRoot, Section } from "@/types/manhour";

import { FISCAL_MONTH_COUNT, assertFiscalMonth, monthToIndex } from "../date";
import type { ActualRow, OrgSnapshot, PlanRow } from "../types";

/** Default label for the company-level root node. */
const DEFAULT_ROOT_NAME = "全公司";

export interface OrgTreeSource {
  /** Departments and sections, as loaded from the org repository. */
  snapshot: OrgSnapshot;
  /** Plan rows for one fiscal year. Missing (section, month) pairs become zeros. */
  plans: readonly PlanRow[];
  /** Actual rows for one fiscal year. Missing (section, month) pairs become zeros. */
  actuals: readonly ActualRow[];
  /** Root node label. Defaults to '全公司'. */
  rootName?: string;
}

/** Invariant 1: a fresh, dense, 12-slot zeroed month array. */
function emptyMonths(): MonthlyHours[] {
  return Array.from({ length: FISCAL_MONTH_COUNT }, () => ({
    plan: 0,
    challenge: 0,
    actual: 0,
  }));
}

/**
 * Invariant 2: order by sortOrder, then by name as a deterministic tiebreaker.
 *
 * `localeCompare` is deliberately avoided - its result depends on the ambient
 * ICU locale, which differs between a developer machine and the server, and the
 * only requirement here is that the order be *stable and reproducible*, not
 * linguistically correct.
 */
function bySortOrderThenName<T extends { sortOrder: number; name: string }>(
  a: T,
  b: T,
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Invariant 4: accumulate `src` into `dest` month by month, in place. */
function addMonthsInto(dest: MonthlyHours[], src: readonly MonthlyHours[]): void {
  for (let i = 0; i < FISCAL_MONTH_COUNT; i += 1) {
    const target = dest[i]!;
    const value = src[i]!;
    target.plan += value.plan;
    target.challenge += value.challenge;
    target.actual += value.actual;
  }
}

/**
 * Invariant 5: every row belongs to the same fiscal year.
 *
 * The mismatch this catches is not hypothetical bad data - it is a caller mistake
 * that the type system cannot see. `findPlansByFiscalYear()` and
 * `findActualsByFiscalYear()` each return one year, but nothing stops a caller from
 * concatenating two years, or from pairing FY2026 plans with FY2027 actuals. Both
 * produce a plausible-looking dashboard built from silently overwritten numbers.
 *
 * Checked across plans AND actuals together, before any folding: mixing years
 * BETWEEN the two collections is the subtler mistake, and it would slip through a
 * per-collection check. Running it up front also keeps the failure point independent
 * of row order.
 *
 * Uses an explicit `seen` flag rather than `expected ??= row.fiscalYearId`: with the
 * nullish assignment, rows whose fiscalYearId is `undefined` never establish a
 * baseline and `undefined !== undefined` is false, so EVERY row passes. TypeScript
 * makes that unreachable today, but this is the one guard that must not fold quietly
 * if a raw import or a loosened type ever lets an undefined through.
 *
 * @throws if the rows span more than one fiscal year.
 */
function assertSingleFiscalYear(
  plans: readonly PlanRow[],
  actuals: readonly ActualRow[],
): void {
  let expected: string | undefined;
  let seen = false;
  // Tracked so the message can distinguish "two years inside one collection" from
  // "each collection is internally consistent but they disagree with each other" -
  // attributing a cross-collection mismatch to the second collection alone sends the
  // reader looking in the wrong place.
  let expectedFrom: "plan" | "actual" = "plan";

  const check = (
    rows: readonly { fiscalYearId: string }[],
    collection: "plan" | "actual",
  ): void => {
    for (const row of rows) {
      if (!seen) {
        expected = row.fiscalYearId;
        expectedFrom = collection;
        seen = true;
        continue;
      }
      if (row.fiscalYearId !== expected) {
        const where =
          expectedFrom === collection
            ? `Mixed fiscal years in ${collection} rows`
            : `Fiscal year mismatch between ${expectedFrom} and ${collection} rows`;
        throw new Error(
          `${where}: ${expected} and ${row.fiscalYearId}. ` +
            "buildOrgRoot() assigns by (sectionId, month); one year would overwrite the other.",
        );
      }
    }
  };

  check(plans, "plan");
  check(actuals, "actual");
}

/**
 * Groups plan/actual rows by section id into dense 12-month arrays.
 *
 * Both row types are folded in one pass per collection so a section that only
 * has actuals (or only plans) still ends up with a full 12-slot array.
 *
 * @throws if the rows span more than one fiscal year, or any month is outside 1..12.
 */
function groupMonthsBySection(
  sectionIds: readonly string[],
  plans: readonly PlanRow[],
  actuals: readonly ActualRow[],
): Map<string, MonthlyHours[]> {
  assertSingleFiscalYear(plans, actuals);

  const bySection = new Map<string, MonthlyHours[]>();
  for (const id of sectionIds) {
    bySection.set(id, emptyMonths());
  }

  for (const row of plans) {
    // Fail loudly: an out-of-range month would index past the array and be
    // silently discarded by JS array semantics.
    assertFiscalMonth(row.month);
    const months = bySection.get(row.sectionId);
    // Rows for sections outside the snapshot (e.g. a section deleted from the
    // org sheet but with history retained, D-153) are ignored rather than
    // fabricating a node the org tree cannot address.
    if (!months) continue;
    const slot = months[monthToIndex(row.month)]!;
    slot.plan = row.plannedHours;
    slot.challenge = row.challengeHours;
  }

  for (const row of actuals) {
    assertFiscalMonth(row.month);
    const months = bySection.get(row.sectionId);
    if (!months) continue;
    const slot = months[monthToIndex(row.month)]!;
    // totalHours is the persisted denormalised sum (personnel + overtime) and is
    // what the dashboard treats as "actual". Overtime may be negative (D-105),
    // so this value is NOT clamped to zero.
    slot.actual = row.totalHours;
  }

  return bySection;
}

/**
 * Pure transform: flat rows -> nested OrgRoot.
 *
 * Deliberately synchronous and dependency-free so the five invariants above can
 * be unit-tested without a database.
 */
export function buildOrgRoot(source: OrgTreeSource): OrgRoot {
  const { snapshot, plans, actuals, rootName = DEFAULT_ROOT_NAME } = source;

  const sectionIds = snapshot.sections.map((s) => s.id);
  const monthsBySection = groupMonthsBySection(sectionIds, plans, actuals);

  // Bucket sections under their department before sorting, so each department's
  // children are sorted independently.
  const sectionsByDept = new Map<string, (typeof snapshot.sections)[number][]>();
  for (const section of snapshot.sections) {
    const bucket = sectionsByDept.get(section.departmentId);
    if (bucket) {
      bucket.push(section);
    } else {
      sectionsByDept.set(section.departmentId, [section]);
    }
  }

  // Invariant 2: copy before sorting - the snapshot arrays are readonly and may
  // be shared with a caller that does not expect them to be reordered.
  const orderedDepts = [...snapshot.departments].sort(bySortOrderThenName);

  const rootMonths = emptyMonths();

  const depts: Dept[] = orderedDepts.map((deptDto) => {
    // Invariant 3: `?? []` keeps childless departments in the output.
    const orderedSections = [...(sectionsByDept.get(deptDto.id) ?? [])].sort(
      bySortOrderThenName,
    );

    const deptMonths = emptyMonths();

    const sections: Section[] = orderedSections.map((sectionDto) => {
      // Guaranteed present: every snapshot section was prefilled above.
      const months = monthsBySection.get(sectionDto.id)!;
      addMonthsInto(deptMonths, months);
      // `base` is intentionally omitted - it is a mock-generator seed with no
      // database counterpart, and nothing outside lib/mock/org.ts reads it.
      return { name: sectionDto.name, months };
    });

    addMonthsInto(rootMonths, deptMonths);

    return { name: deptDto.name, sections, months: deptMonths };
  });

  return { name: rootName, depts, months: rootMonths };
}
