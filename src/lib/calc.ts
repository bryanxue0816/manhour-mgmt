/**
 * Pure calculation functions for the man-hour management dashboard (Phase 1 B2).
 *
 * Every exported function is pure: no side effects, no input mutation.
 * Same inputs always produce the same outputs; each return value is a
 * freshly constructed object or array.
 *
 * Every month-anchored function takes an explicit {@link MonthAxis} rather than
 * reading `CUR_MONTH_IDX` / `MONTHS` from the types module. Those constants
 * hard-code FY2026 and a mock-specific anchor month; reading them here made the
 * whole dashboard fold over a month with no data as soon as real actuals landed
 * in a different month (D-165). The axis is now the caller's decision, so the
 * mock and the database-backed screens can anchor differently without either
 * one carrying a special case.
 */

import {
  type MonthAxis,
  type MonthlyHours,
  type MonthlyNode,
  type OrgRoot,
  type Dept,
  type Section,
  type DrillState,
  type KpiData,
  type ChartMonthData,
  type AchievementTableRow,
  type AchievementCell,
  type BudgetGaugeData,
  type BreadcrumbSegment,
  type UsageTier,
} from '@/types/manhour';

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/** Zero-hours fallback used when a month index is out of range. */
const EMPTY_MONTH: MonthlyHours = { plan: 0, challenge: 0, actual: 0 };

/**
 * Read the anchored month safely. Real DB queries may return fewer than
 * `axis.curIdx + 1` months (a newly created section, a partially loaded fiscal
 * year), and a bare index would produce `undefined` and crash on property
 * access. Falls back to all-zero hours, which downstream ratio guards already
 * handle.
 */
function currentMonth(months: MonthlyHours[], axis: MonthAxis): MonthlyHours {
  return months[axis.curIdx] ?? EMPTY_MONTH;
}

/**
 * Month label for index `i`. Falls back to a 1-based ordinal when the data has
 * more rows than the axis has labels, so a label is never `undefined`.
 */
function monthLabel(axis: MonthAxis, i: number): string {
  return axis.labels[i] ?? `#${i + 1}`;
}

/**
 * Build an achievement cell from a target and an actual value.
 * `diff = target - actual`; `achieved` is true when there is remaining budget.
 */
function makeCell(target: number, actual: number): AchievementCell {
  const diff = target - actual;
  return { diff, achieved: diff > 0 };
}

/**
 * Resolve a department by index, throwing on a miss. A missing department means
 * the drill state and the org tree have diverged — a programming error, not a
 * recoverable data condition, so failing loudly beats rendering wrong numbers.
 */
function requireDept(org: OrgRoot, deptIdx: number): Dept {
  const dept = org.depts[deptIdx];
  if (!dept) {
    throw new Error(`Invalid drill state: no department at index ${deptIdx}`);
  }
  return dept;
}

/** Resolve a section by index, throwing on a miss (see {@link requireDept}). */
function requireSection(dept: Dept, secIdx: number): Section {
  const section = dept.sections[secIdx];
  if (!section) {
    throw new Error(
      `Invalid drill state: no section at index ${secIdx} in "${dept.name}"`,
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Org selection
// ---------------------------------------------------------------------------

/** Result of {@link selectNode}: the focused node plus its children (if any). */
export interface SelectNodeResult {
  node: MonthlyNode;
  /** Child nodes, or null when drilling at the lowest level. */
  children: MonthlyNode[] | null;
  /** Label for the child level, or null at level 2. */
  childTypeLabel: string | null;
}

/**
 * Select the current node and its children based on drill state.
 *
 * - level 0: node = org root, children = departments, label = '部门'
 * - level 1: node = department, children = sections, label = '课'
 * - level 2: node = section, children = null, label = null
 */
export function selectNode(org: OrgRoot, state: DrillState): SelectNodeResult {
  if (state.level === 0) {
    return {
      node: org,
      children: [...org.depts],
      childTypeLabel: '部门',
    };
  }

  if (state.level === 1) {
    const dept = requireDept(org, state.deptIdx);
    return {
      node: dept,
      children: [...dept.sections],
      childTypeLabel: '课',
    };
  }

  // level 2 — leaf node, no children
  const dept = requireDept(org, state.deptIdx);
  return {
    node: requireSection(dept, state.secIdx),
    children: null,
    childTypeLabel: null,
  };
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

/**
 * Compute the four KPI card values for the anchored month (`axis.curIdx`).
 *
 * @param months   12 months of plan/challenge/actual data for the current node.
 * @param levelName Display name of the current node.
 * @param axis     Anchored month index and display labels.
 */
export function computeKpi(
  months: MonthlyHours[],
  levelName: string,
  axis: MonthAxis,
): KpiData {
  const cur = currentMonth(months, axis);
  const monthActual = cur.actual;
  const monthPlan = cur.plan;
  const monthChallenge = cur.challenge;

  const cumActual = cumToCurrent(months.map((m) => m.actual), axis);
  const cumPlan = cumToCurrent(months.map((m) => m.plan), axis);

  // Guard zero-division: ratios default to 0 when the denominator is 0, so
  // downstream KPI text never renders NaN. The mock always has positive plans,
  // but these pure functions will be reused against real DB data later.
  const monthRatio = monthPlan > 0 ? monthActual / monthPlan : 0;
  const cumRatio = cumPlan > 0 ? cumActual / cumPlan : 0;

  return {
    levelName,
    monthLabel: monthLabel(axis, axis.curIdx),
    monthActual,
    monthPlan,
    monthChallenge,
    cumActual,
    cumPlan,
    usedPct: Math.round(monthRatio * 100),
    usedTier: getUsageTier(monthRatio),
    monthPlanRemain: monthPlan - monthActual,
    monthChalRemain: monthChallenge - monthActual,
    cumRemain: cumPlan - cumActual,
    cumUsedPct: Math.round(cumRatio * 100),
  };
}

// ---------------------------------------------------------------------------
// Combo chart
// ---------------------------------------------------------------------------

/**
 * Build 12-month combo-chart data with running cumulative series.
 * Each entry carries the raw month values plus cumulative sums up to that month.
 */
export function computeChartData(
  months: MonthlyHours[],
  axis: MonthAxis,
): ChartMonthData[] {
  const cumPlan = cumFull(months.map((m) => m.plan));
  const cumChallenge = cumFull(months.map((m) => m.challenge));
  const cumActual = cumFull(months.map((m) => m.actual));

  return months.map((m, i) => ({
    month: monthLabel(axis, i),
    plan: m.plan,
    challenge: m.challenge,
    actual: m.actual,
    cumPlan: cumPlan[i] ?? 0,
    cumChallenge: cumChallenge[i] ?? 0,
    cumActual: cumActual[i] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Achievement tables
// ---------------------------------------------------------------------------

/**
 * Overview achievement rows — one row per child node.
 *
 * Cells (4 per row), with CUR = `axis.curIdx`:
 *  [0] anchored-month plan remain    (plan[CUR] - actual[CUR])
 *  [1] anchored-month challenge remain (challenge[CUR] - actual[CUR])
 *  [2] cumulative plan remain       (cumPlan - cumActual, up to CUR)
 *  [3] cumulative challenge remain  (cumChallenge - cumActual, up to CUR)
 */
export function computeOverviewRows(
  children: MonthlyNode[],
  axis: MonthAxis,
): AchievementTableRow[] {
  return children.map((child) => {
    const months = child.months;
    const cur = currentMonth(months, axis);

    const cumPlan = cumToCurrent(months.map((m) => m.plan), axis);
    const cumChallenge = cumToCurrent(months.map((m) => m.challenge), axis);
    const cumActual = cumToCurrent(months.map((m) => m.actual), axis);

    return {
      name: child.name,
      cells: [
        makeCell(cur.plan, cur.actual),
        makeCell(cur.challenge, cur.actual),
        makeCell(cumPlan, cumActual),
        makeCell(cumChallenge, cumActual),
      ],
    };
  });
}

/**
 * Monthly achievement rows — 12 rows (one per month), for Level 2 detail view.
 *
 * Cells (4 per row, for month *i*):
 *  [0] plan[i] - actual[i]
 *  [1] challenge[i] - actual[i]
 *  [2] cumPlan[0..i] - cumActual[0..i]
 *  [3] cumChallenge[0..i] - cumActual[0..i]
 */
export function computeMonthlyRows(
  months: MonthlyHours[],
  axis: MonthAxis,
): AchievementTableRow[] {
  const cumPlan = cumFull(months.map((m) => m.plan));
  const cumChallenge = cumFull(months.map((m) => m.challenge));
  const cumActual = cumFull(months.map((m) => m.actual));

  return months.map((m, i) => ({
    name: monthLabel(axis, i),
    cells: [
      makeCell(m.plan, m.actual),
      makeCell(m.challenge, m.actual),
      makeCell(cumPlan[i] ?? 0, cumActual[i] ?? 0),
      makeCell(cumChallenge[i] ?? 0, cumActual[i] ?? 0),
    ],
  }));
}

// ---------------------------------------------------------------------------
// Budget gauge
// ---------------------------------------------------------------------------

/**
 * Budget gauge data for the Level 2 detail view.
 *
 * Tiers use a different threshold from KPI:
 *   <=50% green / <=80% yellow / >80% red
 */
export function computeBudgetGauge(
  months: MonthlyHours[],
  axis: MonthAxis,
): BudgetGaugeData {
  const totalBudget = months.reduce((sum, m) => sum + m.plan, 0);
  const cumulativeUsed = cumToCurrent(months.map((m) => m.actual), axis);
  const remaining = totalBudget - cumulativeUsed;
  // Guard zero-division (see computeKpi). totalBudget is the sum of all monthly
  // plans; default to 0 when no budget is allocated.
  const ratio = totalBudget > 0 ? cumulativeUsed / totalBudget : 0;

  // Budget-gauge tiers (intentionally different from KPI tiers).
  const usedTier: UsageTier =
    ratio <= 0.5 ? 'green' : ratio <= 0.8 ? 'yellow' : 'red';

  return {
    totalBudget,
    cumulativeUsed,
    remaining,
    usedPct: Math.round(ratio * 100),
    usedTier,
  };
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Build breadcrumb segments from the org tree and current drill state.
 *
 * - level 0: [{ '全社', current }]
 * - level 1: [{ '全社' }, { dept.name, current }]
 * - level 2: [{ '全社' }, { dept.name }, { section.name, current }]
 */
export function buildBreadcrumbSegments(
  org: OrgRoot,
  state: DrillState,
): BreadcrumbSegment[] {
  const root: BreadcrumbSegment = {
    label: '全社',
    level: 0,
    target: { level: 0 },
    isCurrent: state.level === 0,
  };

  if (state.level === 0) {
    return [root];
  }

  const dept = requireDept(org, state.deptIdx);
  const deptSegment: BreadcrumbSegment = {
    label: dept.name,
    level: 1,
    target: { level: 1, deptIdx: state.deptIdx },
    isCurrent: state.level === 1,
  };

  if (state.level === 1) {
    return [root, deptSegment];
  }

  // level 2
  const section = requireSection(dept, state.secIdx);
  return [
    root,
    deptSegment,
    {
      label: section.name,
      level: 2,
      target: { level: 2, deptIdx: state.deptIdx, secIdx: state.secIdx },
      isCurrent: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Cumulative helpers
// ---------------------------------------------------------------------------

/**
 * Cumulative sum from index 0 through `axis.curIdx` (inclusive).
 *
 * A negative `curIdx` would make `slice` count from the end of the array and
 * silently sum the wrong months, so it is clamped to 0 (yielding an empty
 * slice, i.e. 0).
 */
export function cumToCurrent(arr: number[], axis: MonthAxis): number {
  const end = Math.max(0, axis.curIdx + 1);
  return arr.slice(0, end).reduce((sum, v) => sum + v, 0);
}

/** Running cumulative for the entire array (returns a new array of the same length). */
export function cumFull(arr: number[]): number[] {
  let running = 0;
  return arr.map((v) => {
    running += v;
    return running;
  });
}

// ---------------------------------------------------------------------------
// Usage tier
// ---------------------------------------------------------------------------

/**
 * Classify a usage ratio into a tier using KPI thresholds.
 *
 *   ratio < 0.9  → green
 *   0.9 ≤ ratio ≤ 1.0 → yellow
 *   ratio > 1.0  → red
 *
 * Note: {@link computeBudgetGauge} uses its own thresholds, not this function.
 */
export function getUsageTier(ratio: number): UsageTier {
  if (ratio < 0.9) return 'green';
  if (ratio <= 1.0) return 'yellow';
  return 'red';
}
