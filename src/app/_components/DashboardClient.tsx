"use client";

/**
 * Dashboard client shell.
 *
 * Wires the three-level drill-down state machine to the org tree nav,
 * breadcrumb, KPI row, combo chart, and the level-dependent detail panels
 * (overview achievement table for levels 0/1, budget doughnut + monthly
 * achievement table for level 2).
 *
 * Extracted verbatim from the former client-side `app/page.tsx`. The only
 * behavioural change is that the org tree now arrives as a prop instead of
 * being imported from the mock module, so the server can decide whether it
 * came from ORG_MOCK or from the database.
 *
 * The `org` prop identity MUST stay stable across re-renders: every derived
 * value below is memoized on it (and on the drill state), because Recharts
 * replays its full 1500ms enter animation whenever a `data` array identity
 * changes. A server-driven refresh that hands down a fresh object would
 * visibly re-animate the chart.
 */
import { useCallback, useMemo, type ReactNode } from "react";

import { useDrill } from "@/hooks/useDrill";
import {
  CUR_MONTH_IDX,
  MONTHS,
  type MonthAxis,
  type OrgRoot,
} from "@/types/manhour";
import {
  buildBreadcrumbSegments,
  computeBudgetGauge,
  computeChartData,
  computeKpi,
  computeMonthlyRows,
  computeOverviewRows,
  selectNode,
} from "@/lib/calc";
import { resolveCurrentMonthIdx } from "@/lib/current-month";
import { fiscalMonthLabel, FISCAL_MONTH_COUNT, indexToMonth } from "@/lib/db/date";
import { AppShell } from "@/components/layout/AppShell";
import { Breadcrumb } from "@/components/nav/Breadcrumb";
import { OrgTree } from "@/components/tree/OrgTree";
import { KpiRow } from "@/components/kpi/KpiCard";
import { ComboChart } from "@/components/chart/ComboChart";
import { DetailDoughnut } from "@/components/chart/DetailDoughnut";
import { AchievementTable } from "@/components/chart/AchievementTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface DashboardClientProps {
  /** The full org tree, already ordered. Must be referentially stable. */
  org: OrgRoot;
  /**
   * Cross-screen nav, rendered on the server and passed through.
   *
   * A ReactNode rather than a component call because MainNav is a Server
   * Component: importing it here would drag it across the client boundary.
   */
  nav: ReactNode;
  /**
   * Optional full-width alert strip above the KPI row (D-124 staleness).
   *
   * A ReactNode for the same reason `nav` is one: it is rendered on the server, so the
   * staleness verdict and the module that computes it never cross into the client
   * bundle. It also keeps this component ignorant of *why* a banner exists - a second
   * class of warning later needs no change here.
   *
   * Above the KPI row rather than below it: the whole point is that the figures may be
   * incomplete, and a caveat placed after the numbers is read after they have already
   * been believed.
   */
  banner?: ReactNode;
  /** Current fiscal year label, resolved from the database by the page. */
  fiscalYearLabel: string;
  /**
   * Calendar year containing the fiscal year's April, or null for mock data.
   *
   * Drives the month-label axis. Null falls back to the hard-coded FY2026
   * labels in `types/manhour.ts`, which is only correct for the mock - see the
   * page's own comment (D-165).
   */
  fiscalYearStartYear: number | null;
}

export function DashboardClient({
  org,
  nav,
  banner,
  fiscalYearLabel,
  fiscalYearStartYear,
}: DashboardClientProps) {
  const drill = useDrill();
  const drillState = drill.state;
  const drillGo = drill.go;

  /**
   * The month axis, anchored ONCE from the company-wide totals rather than
   * per-node.
   *
   * Deriving it from `node.months` would re-anchor on every drill: a section with
   * no imports yet would fall back to a different month than its parent, so the
   * same 「当月」 label would mean July at level 0 and June at level 2, and the
   * numbers would stop adding up between levels. The company root has data
   * whenever any section does, which makes it the only stable anchor.
   *
   * Memoized on `org` alone: a fresh `labels` array identity on each render would
   * defeat the chart memoization this component exists to protect.
   */
  const axis = useMemo<MonthAxis>(() => {
    const curIdx = resolveCurrentMonthIdx(org.months, CUR_MONTH_IDX);
    if (fiscalYearStartYear === null) return { curIdx, labels: MONTHS };
    const labels = Array.from({ length: FISCAL_MONTH_COUNT }, (_unused, i) =>
      fiscalMonthLabel(fiscalYearStartYear, indexToMonth(i)),
    );
    return { curIdx, labels };
  }, [org, fiscalYearStartYear]);

  // Every derived value below is memoized on the drill state. This is not a
  // micro-optimization: Recharts re-runs its full 1500ms enter animation
  // whenever the `data` array identity changes, so recomputing these on an
  // unrelated re-render would visibly replay the chart.
  const { node, children, childTypeLabel } = useMemo(
    () => selectNode(org, drillState),
    [org, drillState],
  );

  const kpiData = useMemo(
    () => computeKpi(node.months, node.name, axis),
    [node, axis],
  );
  const chartData = useMemo(() => computeChartData(node.months, axis), [node, axis]);
  const breadcrumbSegments = useMemo(
    () => buildBreadcrumbSegments(org, drillState),
    [org, drillState],
  );

  // Overview rows are only meaningful when the node has children (level < 2).
  // Compute once; the null guard doubles as a TypeScript narrowing anchor.
  const overviewRows = useMemo(
    () => (children ? computeOverviewRows(children, axis) : null),
    [children, axis],
  );

  // Level-2-only panels. Computed unconditionally (both are cheap pure folds
  // over 12 months) so the hook order stays stable; only rendered at level 2.
  const budgetGauge = useMemo(
    () => computeBudgetGauge(node.months, axis),
    [node, axis],
  );
  const monthlyRows = useMemo(
    () => computeMonthlyRows(node.months, axis),
    [node, axis],
  );

  /**
   * Overview column headers, naming the anchored month.
   *
   * The default headers say 「当月年计 / 当月挑战」, which has the same defect the KPI
   * titles had: the first two columns fold over the anchored month, not the calendar
   * month (D-165). Only the overview table needs this - at level 2 each ROW is a
   * month, so its default 「当月」 already means "this row's month" and is correct.
   */
  const overviewColumnHeaders = useMemo(
    () => [
      `${axis.labels[axis.curIdx] ?? ""}年计`,
      `${axis.labels[axis.curIdx] ?? ""}挑战`,
      "累计年计",
      "累计挑战",
    ],
    [axis],
  );

  // Clicking an overview row drills one level deeper:
  // company (0) -> dept (1), dept (1) -> section (2).
  const handleOverviewRowClick = useCallback(
    (idx: number) => {
      if (drillState.level === 0) {
        drillGo({ level: 1, deptIdx: idx });
      } else if (drillState.level === 1) {
        drillGo({ level: 2, deptIdx: drillState.deptIdx, secIdx: idx });
      }
    },
    [drillState, drillGo],
  );

  return (
    <AppShell
      nav={nav}
      fiscalYearLabel={fiscalYearLabel}
      breadcrumb={<Breadcrumb segments={breadcrumbSegments} onNavigate={drillGo} />}
      sidebar={<OrgTree org={org} drillState={drillState} onDrill={drillGo} />}
    >
      <div className="space-y-6">
        {/* Staleness / data-health strip, when the server has something to say. */}
        {banner}

        {/* KPI row - four cards driven by the current node's monthly hours. */}
        <KpiRow data={kpiData} />

        {/* Combo chart - monthly bars (plan/challenge/actual) + cumulative triple line, dual Y-axis. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {node.name} · 月度工时推移（计划 / 挑战 / 实绩 + 累计三线）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ComboChart data={chartData} height={380} />
          </CardContent>
        </Card>

        {/* Level 0/1: overview achievement table for direct children (depts or sections). */}
        {overviewRows && childTypeLabel && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{childTypeLabel}达成一览</CardTitle>
            </CardHeader>
            <CardContent>
              <AchievementTable
                rows={overviewRows}
                nameHeader={childTypeLabel}
                onRowClick={handleOverviewRowClick}
                columnHeaders={overviewColumnHeaders}
              />
            </CardContent>
          </Card>
        )}

        {/* Level 2: budget doughnut + monthly achievement detail for the leaf section. */}
        {drillState.level === 2 && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">年度预算使用</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailDoughnut data={budgetGauge} height={240} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">月度达成明细</CardTitle>
              </CardHeader>
              <CardContent>
                <AchievementTable rows={monthlyRows} nameHeader="月份" />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
