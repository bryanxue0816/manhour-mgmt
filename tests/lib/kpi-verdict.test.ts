// Badge label source for the three remaining-hours KPI cards.
//
// The label must be resolved from the SAME predicate that drives emoji and
// pill color, so these tests pin the boundary through kpiVerdict() itself and
// pin the exact wording through the exported constant (a drift sentinel:
// rewording a badge has to be a deliberate test edit, not an unnoticed string
// tweak in one of three call sites).

import { describe, expect, it } from 'vitest';

import { KPI_VERDICT_LABELS, kpiVerdict } from '@/lib/kpi-verdict';

describe('kpiVerdict', () => {
  it('labels a positive remainder as 达成 (on track)', () => {
    expect(kpiVerdict(11359.5)).toEqual({ ok: true, label: '达成' });
  });

  it('labels a negative remainder as 不达成 (off track)', () => {
    expect(kpiVerdict(-260)).toEqual({ ok: false, label: '不达成' });
  });

  it('counts exactly zero as 达成 - the >= 0 boundary (踩线即达成)', () => {
    // Same boundary contract as isRemainOnTrack: dead-on-target is a win.
    expect(kpiVerdict(0)).toEqual({ ok: true, label: '达成' });
  });

  it('exposes the single verbatim label pair shared by all three cards', () => {
    expect(KPI_VERDICT_LABELS.onTrack).toBe('达成');
    expect(KPI_VERDICT_LABELS.offTrack).toBe('不达成');
  });
});
