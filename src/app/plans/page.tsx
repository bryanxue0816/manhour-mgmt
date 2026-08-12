/**
 * /plans - plan-entry screen (D-142: entry is done by 1-2 admins, not by sections).
 *
 * A Server Component that reads the repository layer directly and hands the assembled
 * grid to the client editor. The shape logic lives in `lib/plans/grid.ts` so this file
 * stays fetch-and-render, and so the same `PlanGrid` serves both the aggregates
 * rendered here and the editable cells rendered there.
 *
 * `force-dynamic` is mandatory for the same reason as /admin: without it Next tries
 * to prerender the route at build time and opens a database connection on a machine
 * that has no dev.db, failing the build.
 */
import type { ReactElement } from "react";

import { PlanGridEditor } from "./_components/PlanGridEditor";
import { MainNav } from "@/components/layout/MainNav";
import { findAllFiscalYears, findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import { findPlansByFiscalYear } from "@/lib/db/plan.repo";
import type { FiscalYearDto } from "@/lib/db/types";
import { formatHoursValue } from "@/lib/format";
import { buildPlanGrid } from "@/lib/plans/grid";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "计划工时录入 | 工时管理系统",
  description: "按财年维护各课 12 个月的计划工时与挑战工时",
};

/** A complete fiscal year holds 12 months x 24 sections. */
const EXPECTED_PLAN_ROWS = 288;

/**
 * Resolves which fiscal year to show.
 *
 * `?fy=2026` wins when it names a real year, otherwise the flagged current year,
 * otherwise the newest. The query parameter is validated against the year list
 * rather than parsed and trusted: an unknown value must not produce an empty grid
 * that looks like "no plans entered yet".
 */
function pickFiscalYear(
  years: readonly FiscalYearDto[],
  current: FiscalYearDto | null,
  requested: string | undefined,
): FiscalYearDto | null {
  if (requested !== undefined) {
    const match = years.find((year) => String(year.year) === requested);
    if (match !== undefined) {
      return match;
    }
  }
  return current ?? years[0] ?? null;
}

/** Year tabs. Links rather than a client-side select so the page stays server-only. */
function YearTabs({
  years,
  activeYear,
}: {
  years: readonly FiscalYearDto[];
  activeYear: number;
}): ReactElement {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="财年切换">
      {years.map((year) => {
        const isActive = year.year === activeYear;
        return (
          <a
            key={year.id}
            href={`/plans?fy=${year.year}`}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded-md bg-plan px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground ring-1 ring-border transition-colors hover:bg-muted/70"
            }
          >
            {year.name}
            {year.isCurrent ? " ·当前" : ""}
          </a>
        );
      })}
    </nav>
  );
}

/** One statistic in the header strip. */
function Stat({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "warn";
}): ReactElement {
  return (
    <div className="rounded-lg bg-card px-4 py-3 ring-1 ring-border">
      <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={`mt-1 font-heading text-2xl font-semibold tabular-nums ${
          tone === "warn" ? "text-warn" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** Shown when no fiscal year exists at all - seeding has not run. */
function EmptyState(): ReactElement {
  return (
    <div className="rounded-lg bg-card px-6 py-10 text-center ring-1 ring-border">
      <p className="text-sm text-muted-foreground">
        尚未创建任何财年。请先执行数据初始化(prisma db seed)后再录入计划工时。
      </p>
    </div>
  );
}

export default async function PlansPage({
  searchParams,
}: {
  // Next 16 made searchParams a Promise. Typing it as a plain object still
  // compiles - the generated route validator widens the prop bag with `& any` -
  // but `searchParams?.fy` then reads a property off a Promise and is always
  // undefined, silently pinning the page to the current fiscal year. It has to
  // be awaited.
  searchParams?: Promise<{ fy?: string }>;
}): Promise<ReactElement> {
  const [years, current, snapshot, resolvedSearchParams] = await Promise.all([
    findAllFiscalYears(),
    findCurrentFiscalYear(),
    loadOrgSnapshot(),
    searchParams,
  ]);

  const fiscalYear = pickFiscalYear(years, current, resolvedSearchParams?.fy);
  // Sequential on purpose: the plan query needs the resolved year id, so it cannot
  // join the batch above.
  const plans = fiscalYear === null ? [] : await findPlansByFiscalYear(fiscalYear.id);
  const grid = fiscalYear === null ? null : buildPlanGrid(snapshot, plans, fiscalYear);

  const rowCount = plans.length;
  const isComplete = rowCount === EXPECTED_PLAN_ROWS && grid?.incompleteSections === 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-full space-y-4 px-6 py-6">
          <div className="flex items-center justify-between gap-6">
            <MainNav active="plans" />
            <span className="text-xs text-muted-foreground">
              {fiscalYear === null ? "未设置财年" : fiscalYear.name} · 内网免登录
            </span>
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              计划工时录入
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              按财年维护 {snapshot.sections.length} 个课 × 12 个月的计划工时与挑战工时。
              每格上行为计划,下行为挑战;挑战高于计划为允许情况(D-151),仅作提示。
            </p>
          </div>
          {years.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <YearTabs years={years} activeYear={fiscalYear?.year ?? 0} />
              <a
                href="/plans/import"
                className="inline-flex items-center rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground ring-1 ring-border transition-colors hover:bg-muted/70"
              >
                Excel 批量导入
              </a>
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-full space-y-6 px-6 py-8">
        {grid === null || fiscalYear === null ? (
          <EmptyState />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="计划行数"
                value={`${rowCount} / ${EXPECTED_PLAN_ROWS}`}
                tone={isComplete ? "normal" : "warn"}
              />
              <Stat
                label="数据不完整的课"
                value={String(grid.incompleteSections)}
                tone={grid.incompleteSections > 0 ? "warn" : "normal"}
              />
              <Stat label="计划工时合计" value={formatHoursValue(grid.plannedTotal)} />
              <Stat label="挑战工时合计" value={formatHoursValue(grid.challengeTotal)} />
            </div>

            {grid.invertedCells > 0 ? (
              <div className="rounded-lg bg-challenge/10 px-4 py-3 text-sm text-foreground ring-1 ring-challenge/30">
                共 {grid.invertedCells} 个格子的挑战工时高于计划工时。
                按 D-151 原样保留,仅作提示,请确认是否符合业务预期。
              </div>
            ) : null}

            <PlanGridEditor grid={grid} fiscalYearId={fiscalYear.id} />

            <p className="text-xs text-muted-foreground">
              直接点格子修改,离开格子即保存;按 Esc 撤销尚未保存的输入。
              每次修改都会写入修改留痕(D-143),留痕仅影响后续计算,不撤回历史预警。
              合计与完整度统计在保存后自动刷新。
            </p>
          </>
        )}
      </main>
    </div>
  );
}
