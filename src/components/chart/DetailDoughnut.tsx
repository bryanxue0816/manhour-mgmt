'use client';

import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import type { BudgetGaugeData } from '@/types/manhour';
import { CHART_COLORS, TIER_FILL, TIER_BAR_CLASS } from '@/lib/chart-colors';
import { formatHours } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface DetailDoughnutProps {
  /** Budget-gauge payload for the current drill node. */
  data: BudgetGaugeData;
  /** Fixed height of the gauge (doughnut + center label) in px. Default 240. */
  height?: number;
}

/**
 * Level-2 detail budget gauge: a half-doughnut ("speedometer") showing
 * year-to-date budget consumption for the selected drill node.
 *
 * Rendering notes (aligned with v18 Level-2 budget dashboard):
 * - The Pie uses startAngle=180 / endAngle=0 to render only the upper
 *   semicircle; the circle center sits on the vertical midpoint of the
 *   fixed-height wrapper, so an `absolute inset-0 items-center` label
 *   aligns to the circle center (diameter line) automatically.
 * - The "used" segment is tinted by `usedTier` (green/yellow/red); the
 *   "remaining" segment is a neutral light gray.
 * - Recharts fills use hex values (see `lib/chart-colors`); the progress bar
 *   below uses CSS-variable utility classes (bg-challenge / bg-warn /
 *   bg-actual) per the spec.
 * - The wrapper has a fixed height to prevent ResponsiveContainer collapse.
 * - `'use client'` is required because Recharts depends on ResizeObserver.
 */
export function DetailDoughnut({ data, height = 240 }: DetailDoughnutProps): JSX.Element {
  const { totalBudget, cumulativeUsed, remaining, usedPct, usedTier } = data;

  // Clamp pie values to >= 0: an over-budget (negative remaining) node would
  // otherwise break Recharts. The stat box still shows the real (possibly
  // negative) remaining figure so overruns stay visible.
  const pieUsed = Math.max(cumulativeUsed, 0);
  const pieRemaining = Math.max(remaining, 0);

  // Ensure at least one positive slice so an empty/zero-budget node still
  // renders a full gray arc instead of a blank chart.
  const pieData =
    pieUsed > 0 || pieRemaining > 0
      ? [
          { name: '已用', value: pieUsed },
          { name: '剩余', value: pieRemaining },
        ]
      : [{ name: '剩余', value: 1 }];

  return (
    <div className="w-full">
      {/* Half-doughnut gauge + centered percentage label. */}
      <div className="relative w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart aria-label={`年计工时预算使用率半环图：已使用 ${usedPct}%`}>
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              startAngle={180}
              endAngle={0}
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
            >
              {pieData.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.name === '已用' ? TIER_FILL[usedTier] : CHART_COLORS.neutral}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Center label: percentage + caption, aligned to the circle center
            (vertical midpoint of the wrapper == diameter line of the arc). */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-3xl font-semibold tabular-nums">{usedPct}%</div>
            <div className="text-xs text-muted-foreground">年计工时已使用</div>
          </div>
        </div>
      </div>

      {/* Three stat boxes: annual budget / cumulative used / remaining. */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="年计工时" value={formatHours(totalBudget)} />
        <StatBox label="累计已用" value={formatHours(cumulativeUsed)} />
        <StatBox label="剩余可用" value={formatHours(remaining)} />
      </div>

      {/* Progress bar: width clamped to 100%, colored by tier. */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', TIER_BAR_CLASS[usedTier])}
          style={{ width: `${Math.min(Math.max(usedPct || 0, 0), 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Compact label + value box used for the three gauge stats. */
interface StatBoxProps {
  label: string;
  value: string;
}

function StatBox({ label, value }: StatBoxProps): JSX.Element {
  return (
    <div className="rounded-md bg-muted/50 p-2 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}
