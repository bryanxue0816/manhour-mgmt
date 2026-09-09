/**
 * Man-hour management system - core domain types.
 *
 * These types are the single source of truth for the v0.1 mock dashboard.
 * Every component and calc function imports from here; no `any` is allowed.
 *
 * Fiscal year FY2026 = 2026-04 ~ 2027-03 (D-004). Month index 0 maps to April.
 */

/**
 * FY2026 month labels (index 0 = April).
 *
 * FALLBACK ONLY - not the source of truth for any database-backed screen. These
 * twelve strings hard-code FY2026, so a dashboard showing FY2027 data would keep
 * saying `26/xx`. Real labels are derived per fiscal year by
 * `lib/db/date.ts#fiscalMonthLabel`, and the dashboard builds its own
 * {@link MonthAxis} from the loaded year (D-165).
 *
 * Retained because `lib/mock/org.ts` has no fiscal year to derive from, and
 * because it is the axis used when the org tree degrades to mock data.
 */
export const MONTHS: readonly string[] = [
  '26/04', '26/05', '26/06', '26/07', '26/08', '26/09',
  '26/10', '26/11', '26/12', '27/01', '27/02', '27/03',
];

/**
 * Mock current-month index (index 2 = June = FY month 3).
 *
 * FALLBACK ONLY, for the same reason as {@link MONTHS}. It is neither today nor
 * where the data is, and anchoring real calculations here makes every KPI read
 * `0 H / 0% / 达成` on a fiscal year whose only imported month sits elsewhere -
 * a dashboard that looks healthy while showing nothing (D-165).
 *
 * Real screens call `lib/current-month.ts#resolveCurrentMonthIdx`, which derives
 * the anchor from the data and only falls back to this value when no month has
 * actual hours at all. `lib/mock/org.ts` still keys its hand-tuned
 * current-month ratios off this index, which is why the fallback must stay 2.
 */
export const CUR_MONTH_IDX = 2;

/**
 * The month axis a dashboard render is anchored to.
 *
 * Bundled into one object rather than threaded as two parameters because every
 * calc function needs both, and because the dashboard memoizes it: a fresh
 * `labels` array identity on each render would defeat the memoization that keeps
 * Recharts from replaying its 1500ms enter animation.
 */
export interface MonthAxis {
  /**
   * Index treated as "current" for all month/cumulative folds. Must be a valid
   * index into the node's `months` array - see resolveCurrentMonthIdx().
   */
  curIdx: number;
  /** Display label per month index, e.g. `['26/04', …, '27/03']`. */
  labels: readonly string[];
}

/** Single-month plan / challenge / actual hours. */
export interface MonthlyHours {
  /** Planned hours (budget). */
  plan: number;
  /**
   * Challenge hours (the more aggressive target).
   *
   * NOT assumed to be <= plan. D-151 made the plan-vs-challenge relation
   * non-enforcing, so either direction is valid data and no consumer may treat
   * one as an upper bound on the other.
   */
  challenge: number;
  /** Actual hours (realized). */
  actual: number;
}

/** Section (lowest org unit). */
export interface Section {
  name: string;
  /**
   * Base hours used only to deterministically generate the mock monthly curve.
   * Optional because database-backed sections have no such seed - their months
   * come from real Plan/Actual rows. Nothing outside lib/mock/org.ts reads it.
   */
  base?: number;
  /** 12 months of data (index 0 = April). */
  months: MonthlyHours[];
}

/** Department (contains sections + aggregated monthly data). */
export interface Dept {
  name: string;
  sections: Section[];
  /** Aggregated from sections (per-month sum). */
  months: MonthlyHours[];
}

/** Org root (whole company; contains departments + aggregated monthly data). */
export interface OrgRoot {
  name: string;
  depts: Dept[];
  /** Aggregated from departments (per-month sum). */
  months: MonthlyHours[];
}

/** Structural type: any node that has a name and 12 months of data. */
export interface MonthlyNode {
  name: string;
  months: MonthlyHours[];
}

/** Drill level: 0 = whole company, 1 = department, 2 = section. */
export type DrillLevel = 0 | 1 | 2;

/**
 * Drill state held at the page top level.
 *
 * Modeled as a discriminated union on `level` so illegal combinations
 * (e.g. `level: 1` without a `deptIdx`) are unrepresentable. This lets
 * consumers narrow by `level` instead of asserting with `!`.
 */
export type DrillState =
  | { level: 0 }
  | { level: 1; deptIdx: number }
  | { level: 2; deptIdx: number; secIdx: number };

/**
 * Currently selected department index, or null at level 0. Helper for consumers
 * that only need the index and should not have to switch on `level`.
 */
export function drillDeptIdx(state: DrillState): number | null {
  return state.level === 0 ? null : state.deptIdx;
}

/** Currently selected section index, or null above level 2. */
export function drillSecIdx(state: DrillState): number | null {
  return state.level === 2 ? state.secIdx : null;
}

/** Budget-usage tier for KPI #1 progress bar coloring (D-154). */
export type UsageTier = 'green' | 'yellow' | 'red';

/** KPI four-card computation result. */
export interface KpiData {
  /** Display name of the current node ('全社' / dept.name / section.name). */
  levelName: string;
  /**
   * Label of the anchored month, e.g. `'26/07'`.
   *
   * Surfaced so the cards can say WHICH month they report on. The anchor is the
   * newest month with data, which is routinely not the calendar month, and a card
   * reading just 「当月实绩」 invites reading a July figure as an August one (D-165).
   */
  monthLabel: string;
  /** actual[axis.curIdx] */
  monthActual: number;
  /** plan[axis.curIdx] */
  monthPlan: number;
  /** challenge[axis.curIdx] */
  monthChallenge: number;
  /** sum(actual[0..axis.curIdx]) */
  cumActual: number;
  /** sum(plan[0..axis.curIdx]) */
  cumPlan: number;
  /** Math.round(monthActual / monthPlan * 100) */
  usedPct: number;
  /** <90% green / 90-100% yellow / >100% red */
  usedTier: UsageTier;
  /** monthPlan - monthActual (>=0 = on track; exactly 0 is landing on target, see isRemainOnTrack) */
  monthPlanRemain: number;
  /** monthChallenge - monthActual */
  monthChalRemain: number;
  /** cumPlan - cumActual */
  cumRemain: number;
  /** Math.round(cumActual / cumPlan * 100) */
  cumUsedPct: number;
}

/** One combo-chart data point (per month, with running cumulative). */
export interface ChartMonthData {
  /** Month label, e.g. "26/04". */
  month: string;
  plan: number;
  challenge: number;
  actual: number;
  /** Running cumulative plan up to this month. */
  cumPlan: number;
  cumChallenge: number;
  cumActual: number;
}

/** A single achievement-status cell. */
export interface AchievementCell {
  /** target - actual (>0 = achieved). */
  diff: number;
  /** diff > 0. */
  achieved: boolean;
}

/** One achievement-table row (used by both overview and detail views). */
export interface AchievementTableRow {
  /** Department name / section name / month label. */
  name: string;
  /** Exactly 4 cells: [monthPlan, monthChallenge, cumPlan, cumChallenge]. */
  cells: AchievementCell[];
}

/** Budget-gauge data for the Level-2 detail view. */
export interface BudgetGaugeData {
  /** sum(plan[0..11]) - full-year plan. */
  totalBudget: number;
  /** sum(actual[0..axis.curIdx]) - cumulative actual. */
  cumulativeUsed: number;
  /** totalBudget - cumulativeUsed. */
  remaining: number;
  /** Math.round(cumulativeUsed / totalBudget * 100). */
  usedPct: number;
  /** <=50% green / <=80% yellow / >80% red. */
  usedTier: UsageTier;
}

/** One breadcrumb segment. */
export interface BreadcrumbSegment {
  label: string;
  /** Drill level of this segment — drives the L0/L1/L2 badge color. */
  level: DrillLevel;
  /** Drill state to apply when this segment is clicked. */
  target: DrillState;
  /** Current segment (not clickable). */
  isCurrent: boolean;
}
