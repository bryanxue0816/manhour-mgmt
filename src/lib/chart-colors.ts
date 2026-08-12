/**
 * Chart palette — the single source of truth for hex colors used inside SVG
 * charts (Recharts fills/strokes cannot consume CSS custom properties during
 * SSR, so the hex values must live in TypeScript).
 *
 * These MUST stay in sync with the design tokens in `globals.css`:
 *   --plan      #4a90d9
 *   --challenge #2e9e4f
 *   --actual    #dc000c
 *   --warn      #f0a13a
 *
 * Tailwind utility classes (bg-plan / bg-challenge / ...) still reference the
 * CSS tokens directly, because Tailwind only scans literal class names.
 */

import type { UsageTier } from '@/types/manhour';

/** Brand series colors, mirroring the v18 design source. */
export const CHART_COLORS = {
  /** 计划 (plan) — single-month bar. */
  plan: '#4a90d9',
  /** 挑战 (challenge) — single-month bar + cumulative line. */
  challenge: '#2e9e4f',
  /** 实绩 (actual) — single-month bar + cumulative line. */
  actual: '#dc000c',
  /** Warning amber, used by the budget-gauge middle tier. */
  warn: '#f0a13a',
  /** Cumulative-plan line: a darker blue so it separates from the plan bar. */
  cumPlan: '#1a5fb4',
  /** Neutral gray for the "remaining" doughnut segment. */
  neutral: '#e5e7eb',
} as const;

/** Doughnut "used" arc fill, keyed by usage tier. */
export const TIER_FILL: Record<UsageTier, string> = {
  green: CHART_COLORS.challenge,
  yellow: CHART_COLORS.warn,
  red: CHART_COLORS.actual,
};

/**
 * Progress-bar background utility, keyed by usage tier. Literal class names are
 * required so Tailwind's scanner keeps these utilities in the build.
 */
export const TIER_BAR_CLASS: Record<UsageTier, string> = {
  green: 'bg-challenge',
  yellow: 'bg-warn',
  red: 'bg-actual',
};
