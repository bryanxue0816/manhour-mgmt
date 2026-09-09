// Single source of truth for the three remaining-hours KPI verdict badges.
//
// Before 2026-09-09 the three cards carried three different wordings
// (达成/超支, 优于挑战/未达挑战, and a numeric ▲/▼ sentence). The predicate was
// already shared (isRemainOnTrack); only the labels had drifted. Binding the
// label to the same predicate here makes a second wording split structurally
// impossible: cards call kpiVerdict() instead of owning strings.

import { isRemainOnTrack } from '@/lib/calc';

/** Verbatim badge labels. Tests assert these exact strings (drift sentinel). */
export const KPI_VERDICT_LABELS = {
  onTrack: '达成',
  offTrack: '不达成',
} as const;

export interface KpiVerdict {
  /** Shared >= 0 predicate result; also drives emoji and pill color. */
  ok: boolean;
  /** Badge wording resolved from the same remainder value. */
  label: string;
}

/**
 * Resolve the verdict (state + badge label) for one remaining-hours figure.
 * The boundary is exactly isRemainOnTrack's: remainder >= 0 is on track and
 * exactly 0 counts as 达成.
 */
export function kpiVerdict(remain: number): KpiVerdict {
  const ok = isRemainOnTrack(remain);
  return {
    ok,
    label: ok ? KPI_VERDICT_LABELS.onTrack : KPI_VERDICT_LABELS.offTrack,
  };
}
