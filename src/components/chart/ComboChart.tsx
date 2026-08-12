'use client';

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  Label,
} from 'recharts';
import type { ChartMonthData } from '@/types/manhour';
import { CHART_COLORS } from '@/lib/chart-colors';
import { formatHoursUnknown } from '@/lib/format';

export interface ComboChartProps {
  /** 12 monthly data points (FY April ~ March). */
  data: ChartMonthData[];
  /** Fixed outer height in px; ResponsiveContainer fills it. Default 380. */
  height?: number;
}

/**
 * Marker shape for each cumulative line, mirroring v18's Chart.js pointStyle:
 * 累计计划 = circle, 累计挑战 = triangle, 累计实绩 = rectRot (diamond).
 *
 * Three distinct shapes (not just three dash patterns) are what make the
 * cumulative series readable when the lines overlap.
 */
type MarkerShape = 'circle' | 'triangle' | 'diamond';

/** Marker radius at rest (default) and while hovered. */
const DOT_R = 5;
const ACTIVE_DOT_R = 7;

/** Recharts `dot` / `activeDot` renderer props (only the fields we need). */
interface DotRenderProps {
  cx?: number;
  cy?: number;
}

/**
 * Build a hollow marker renderer for a cumulative line: white fill + colored
 * stroke, matching the legend swatch so the chart and legend read as one.
 *
 * Returns a plain function, not a component: Recharts invokes a function-typed
 * `dot`/`activeDot` directly (`option(dotProps)` in `component/Dots.js` and
 * `component/ActivePoints.js`) rather than passing it to `createElement`, so the
 * rendered element type is always the module-level `MarkerGlyph` and this
 * factory does not introduce remounts.
 */
function makeDot(shape: MarkerShape, color: string, r = DOT_R) {
  return function renderDot({ cx, cy }: DotRenderProps) {
    if (cx === undefined || cy === undefined) return null;
    return <MarkerGlyph shape={shape} cx={cx} cy={cy} r={r} color={color} />;
  };
}

interface MarkerGlyphProps {
  shape: MarkerShape;
  cx: number;
  cy: number;
  r: number;
  color: string;
  /** Solid fill instead of hollow — used for the single-month bar swatches. */
  filled?: boolean;
}

/**
 * Shared SVG glyph used both as a line dot and as a legend swatch, so the three
 * cumulative series carry the same symbol in the legend as on the chart.
 *
 * Note: the three single-month series are bars on the chart but are drawn as
 * filled circles in the legend — a deliberate simplification, since an 8px-wide
 * bar swatch reads poorly at legend size.
 */
function MarkerGlyph({ shape, cx, cy, r, color, filled = false }: MarkerGlyphProps) {
  const fill = filled ? color : '#fff';
  const strokeWidth = 2;

  if (shape === 'triangle') {
    // Upward triangle centered on (cx, cy).
    const points = `${cx},${cy - r} ${cx + r},${cy + r * 0.8} ${cx - r},${cy + r * 0.8}`;
    return <polygon points={points} fill={fill} stroke={color} strokeWidth={strokeWidth} />;
  }

  if (shape === 'diamond') {
    // Square rotated 45deg (Chart.js "rectRot").
    const points = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
    return <polygon points={points} fill={fill} stroke={color} strokeWidth={strokeWidth} />;
  }

  return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={color} strokeWidth={strokeWidth} />;
}

/** One legend entry: symbol spec + label. */
interface LegendItem {
  label: string;
  color: string;
  shape: MarkerShape;
  /** Cumulative lines are hollow; single-month bars are solid. */
  filled: boolean;
  /** Dash pattern of the connecting line (cumulative series only). */
  dash?: string;
}

/**
 * Legend items in v18 order: three cumulative lines first (hollow symbols with
 * their line style), then the three single-month bars (solid dots).
 */
const LEGEND_ITEMS: readonly LegendItem[] = [
  { label: '累计计划', color: CHART_COLORS.cumPlan, shape: 'circle', filled: false },
  { label: '累计挑战', color: CHART_COLORS.challenge, shape: 'triangle', filled: false, dash: '8 4' },
  { label: '累计实绩', color: CHART_COLORS.actual, shape: 'diamond', filled: false, dash: '2 3' },
  { label: '计划(单月)', color: CHART_COLORS.plan, shape: 'circle', filled: true },
  { label: '挑战(单月)', color: CHART_COLORS.challenge, shape: 'circle', filled: true },
  { label: '实绩(单月)', color: CHART_COLORS.actual, shape: 'circle', filled: true },
];

/**
 * Custom legend replacing Recharts' default swatches (which render bars as
 * squares and every line identically). Cumulative entries draw the same glyph
 * and dash pattern the series uses on the chart, so the six series stay
 * distinguishable.
 */
function ChartLegend() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-1 text-xs">
      {LEGEND_ITEMS.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <svg width={26} height={14} aria-hidden="true">
            {/* Cumulative entries show their dashed connector behind the glyph. */}
            {!item.filled && (
              <line
                x1={1}
                y1={7}
                x2={25}
                y2={7}
                stroke={item.color}
                strokeWidth={2}
                strokeDasharray={item.dash}
              />
            )}
            <MarkerGlyph
              shape={item.shape}
              cx={13}
              cy={7}
              r={DOT_R}
              color={item.color}
              filled={item.filled}
            />
          </svg>
          <span className="text-foreground">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Combo chart: single-month bars (plan / challenge / actual) on the left axis
 * plus running cumulative lines on the right axis. Uses dual Y axes with
 * matching tickCount (6) for consistent tick density. Note: each axis computes
 * its own [0, auto] max independently, so right-axis ticks do not sit on the
 * left-axis grid lines; CartesianGrid follows the left axis only.
 *
 * Spike-verified patterns (do not deviate):
 * - Every series carries an explicit `yAxisId` (omitting it silently binds the
 *   default axis and misaligns rendering).
 * - `domain={[0, 'auto']}` anchors the baseline at 0 to avoid misleading scales.
 * - Outer wrapper has a fixed height to prevent ResponsiveContainer collapse.
 * - `'use client'` is required because Recharts depends on ResizeObserver.
 *
 * Legend/marker fidelity (v18 parity):
 * - The three cumulative lines use three DISTINCT hollow marker shapes
 *   (circle / triangle / diamond) plus distinct dash patterns.
 * - A custom legend renders the same glyphs, since Recharts' default legend
 *   cannot express per-series point styles.
 */
export function ComboChart({ data, height = 380 }: ComboChartProps): JSX.Element {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 20, right: 56, bottom: 8, left: 18 }}
          aria-label="管间总劳动时间管理表：单月计划／挑战／实绩工时柱状图与累计工时折线图"
        >
          <CartesianGrid stroke="#eef" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="month" tickLine={false} />
          {/* Left axis: single-month bars */}
          <YAxis yAxisId="left" orientation="left" domain={[0, 'auto']} tickCount={6}>
            <Label
              value="单月工时 (H)"
              angle={-90}
              position="insideLeft"
              style={{ textAnchor: 'middle', fontSize: 12, fill: '#6b7280' }}
            />
          </YAxis>
          {/* Right axis: cumulative lines (no grid) */}
          <YAxis yAxisId="right" orientation="right" domain={[0, 'auto']} tickCount={6}>
            <Label
              value="累计工时 (H)"
              angle={90}
              position="insideRight"
              style={{ textAnchor: 'middle', fontSize: 12, fill: '#6b7280' }}
            />
          </YAxis>
          <Tooltip formatter={formatHoursUnknown} />
          <Legend content={<ChartLegend />} verticalAlign="top" />
          <Bar
            yAxisId="left"
            dataKey="plan"
            name="计划(单月)"
            fill={CHART_COLORS.plan}
            barSize={8}
          />
          <Bar
            yAxisId="left"
            dataKey="challenge"
            name="挑战(单月)"
            fill={CHART_COLORS.challenge}
            barSize={8}
          />
          <Bar
            yAxisId="left"
            dataKey="actual"
            name="实绩(单月)"
            fill={CHART_COLORS.actual}
            barSize={8}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumPlan"
            name="累计计划"
            stroke={CHART_COLORS.cumPlan}
            strokeWidth={2.5}
            dot={makeDot('circle', CHART_COLORS.cumPlan)}
            activeDot={makeDot('circle', CHART_COLORS.cumPlan, ACTIVE_DOT_R)}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumChallenge"
            name="累计挑战"
            stroke={CHART_COLORS.challenge}
            strokeWidth={2.5}
            strokeDasharray="8 4"
            dot={makeDot('triangle', CHART_COLORS.challenge, 5.5)}
            activeDot={makeDot('triangle', CHART_COLORS.challenge, ACTIVE_DOT_R)}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumActual"
            name="累计实绩"
            stroke={CHART_COLORS.actual}
            strokeWidth={2.5}
            strokeDasharray="2 3"
            dot={makeDot('diamond', CHART_COLORS.actual, 5.5)}
            activeDot={makeDot('diamond', CHART_COLORS.actual, ACTIVE_DOT_R)}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
