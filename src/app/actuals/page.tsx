/**
 * /actuals - actual-hours screen: what the attendance import actually produced.
 *
 * A Server Component that reads the repository layer directly. The shape logic lives
 * in `lib/attendance/actuals-view.ts` so this file stays fetch-and-render, mirroring
 * the /plans + lib/plans/grid.ts split.
 *
 * Three things on one page, on purpose. The section x month figures are only
 * trustworthy in the company of (a) the import health panel - a stale table with a
 * FAILED import behind it looks exactly like a correct one - and (b) the unattributed
 * banner, because those hours ARE counted in the company total (D-118: 默认全额计入)
 * but belong to no section, so the section rows below sum to less than the total and
 * that gap has to be visible rather than discovered.
 *
 * `force-dynamic` is mandatory for the same reason as /plans and /admin: without it
 * Next tries to prerender the route at build time and opens a database connection on
 * a machine that has no dev.db, failing the build.
 */
import type { ReactElement } from "react";

import { MainNav } from "@/components/layout/MainNav";
import { buildActualsView } from "@/lib/attendance/actuals-view";
import {
  describeImportStaleness,
  type ImportStaleness,
} from "@/lib/attendance/import-staleness";
import { findActualsByFiscalYear } from "@/lib/db/actual.repo";
import { findUnattributedHours } from "@/lib/db/attendance.repo";
import { fiscalMonthLabel } from "@/lib/db/date";
import { findAllFiscalYears, findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";
import { findLatestSuccessfulImportLog, findRecentImportLogs } from "@/lib/db/import-log.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import type { FiscalYearDto, ImportLogDto, ImportStatus } from "@/lib/db/types";
import { formatHoursValue } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "实绩工时 | 工时管理系统",
  description: "按财年查看各课 12 个月的实绩工时,以及考勤数据导入状态与未归属工时告警",
};

/** Rows in the import history table. Enough to cover several weeks of daily runs. */
const IMPORT_HISTORY_LIMIT = 10;

/**
 * Resolves which fiscal year to show.
 *
 * `?fy=2026` wins when it names a real year, otherwise the flagged current year,
 * otherwise the newest. The query parameter is validated against the year list rather
 * than parsed and trusted: an unknown value must not produce an empty table that looks
 * like "no attendance imported yet". Same rule as /plans.
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

/**
 * Resolves the month the unattributed banner reports on.
 *
 * `?month=4` wins when it names a month that actually has data, otherwise the newest
 * month with data. Deliberately NOT today's fiscal month: the calendar month and the
 * last imported month are routinely different, and defaulting to today would show an
 * empty banner for a month nobody has imported - which reads as "nothing unattributed"
 * instead of "no data".
 */
function pickFocusMonth(
  monthsWithData: readonly number[],
  requested: string | undefined,
): number | null {
  if (requested !== undefined) {
    const parsed = Number.parseInt(requested, 10);
    if (monthsWithData.includes(parsed)) {
      return parsed;
    }
  }
  return monthsWithData.at(-1) ?? null;
}

/** Absolute local timestamp. A relative "3 小时前" would need a client component. */
function formatTimestamp(value: Date | null): string {
  if (value === null) {
    return "（未知）";
  }
  return value.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const STATUS_LABELS: Readonly<Record<ImportStatus, string>> = {
  SUCCESS: "成功",
  PARTIAL: "部分成功",
  FAILED: "失败",
};

const TRIGGER_LABELS: Readonly<Record<ImportLogDto["triggeredBy"], string>> = {
  schedule: "定时",
  manual: "手工",
  retry: "重试",
};

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
            href={`/actuals?fy=${year.year}`}
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
function EmptyYearState(): ReactElement {
  return (
    <div className="rounded-lg bg-card px-6 py-10 text-center ring-1 ring-border">
      <p className="text-sm text-muted-foreground">
        尚未创建任何财年。请先执行数据初始化(prisma db seed)后再查看实绩工时。
      </p>
    </div>
  );
}

/**
 * Shown when the year exists but no attendance has been imported into it.
 *
 * Points at the upload page, not at scripts/fetch-attendance.ts. D-170 made the browser the
 * routine entry point; telling an operator to run a TypeScript file is an instruction they
 * cannot follow, and the script reads from a share this app cannot see anyway.
 */
function NoActualsState({ fiscalYearName }: { fiscalYearName: string }): ReactElement {
  return (
    <div className="rounded-lg bg-card px-6 py-10 text-center ring-1 ring-border">
      <p className="text-sm text-muted-foreground">
        {fiscalYearName} 尚无实绩工时。请先
        <a
          href="/actuals/import"
          className="mx-1 font-medium text-actual underline-offset-4 hover:underline"
        >
          导入考勤数据
        </a>
        ,上传 HR 日考勤报表后本页即会显示各课工时。
      </p>
    </div>
  );
}

/**
 * Import health panel: latest attempt, staleness warning, then recent history.
 *
 * The headline figure is the latest attempt of ANY status, not the latest success.
 * D-124 hangs on this distinction - a green "上次成功 昨天 06:00" beside a table
 * silently missing today's data is exactly the failure this panel exists to prevent.
 *
 * The staleness row answers the other half of the same question. A recent FAILED attempt
 * makes the badge above go warn-coloured, but a pipeline that has been quietly succeeding
 * at nothing - or not running at all - produces no failed row to notice. Only elapsed time
 * since the last SUCCESS catches that, which is why the two signals are separate lines
 * rather than one merged verdict.
 */
function ImportStatusPanel({
  logs,
  staleness,
}: {
  logs: readonly ImportLogDto[];
  staleness: ImportStaleness;
}): ReactElement {
  const latest = logs[0];

  if (latest === undefined) {
    return (
      <section className="rounded-lg bg-card p-5 ring-1 ring-border">
        <h2 className="font-heading text-base font-semibold">导入状态</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          尚无导入记录。请前往
          <a
            href="/actuals/import"
            className="mx-1 font-medium text-actual underline-offset-4 hover:underline"
          >
            导入考勤数据
          </a>
          上传 HR 日考勤报表。
        </p>
      </section>
    );
  }

  const isBad = latest.status !== "SUCCESS";

  return (
    <section className="rounded-lg bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-heading text-base font-semibold">导入状态</h2>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ${
            isBad ? "bg-warn/15 text-warn" : "bg-muted text-muted-foreground"
          }`}
        >
          最近一次:{STATUS_LABELS[latest.status]} · {formatTimestamp(latest.importedAt)}
        </span>
      </div>

      {isBad ? (
        <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-sm text-foreground ring-1 ring-warn/30">
          最近一次导入未完全成功,下方实绩数据可能不是最新的。
          {latest.errorMessage === null ? "" : `错误:${latest.errorMessage}`}
        </p>
      ) : null}

      {staleness.message === null ? null : (
        <p
          role="alert"
          className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-sm text-foreground ring-1 ring-warn/30"
        >
          {staleness.message}
          <a
            href="/actuals/import"
            className="ml-1 font-medium text-actual underline-offset-4 hover:underline"
          >
            立即导入 →
          </a>
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            最近 {logs.length} 次考勤数据导入记录,含状态、来源、行数与文件时间
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase">
              <th scope="col" className="py-2 pr-3 font-semibold">
                状态
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                导入时间
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                触发
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                行数
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                文件
              </th>
              <th scope="col" className="py-2 font-semibold">
                文件时间
              </th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const failed = log.status === "FAILED";
              const partial = log.status === "PARTIAL";
              return (
                <tr
                  key={log.id}
                  className={`border-b border-border/60 last:border-0 ${
                    failed ? "bg-warn/5" : ""
                  }`}
                >
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-flex items-center gap-1.5 ${
                        failed || partial ? "text-warn" : "text-muted-foreground"
                      }`}
                    >
                      {/* A coloured dot alone would carry the meaning in hue only; the
                          label beside it is the accessible half of the same signal. */}
                      <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${
                          failed ? "bg-warn" : partial ? "bg-challenge" : "bg-plan"
                        }`}
                      />
                      {STATUS_LABELS[log.status]}
                    </span>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                    {formatTimestamp(log.importedAt)}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {TRIGGER_LABELS[log.triggeredBy]}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{log.rowCount}</td>
                  <td className="max-w-[18rem] truncate py-2 pr-3" title={log.fileName}>
                    {log.fileName}
                  </td>
                  <td className="py-2 tabular-nums text-muted-foreground">
                    {formatTimestamp(log.fileMtime)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Unattributed-hours banner for one fiscal month.
 *
 * Wording matters here and is deliberate: these hours are NOT lost. D-118 keeps them
 * in the company total in full; they simply have no (部, 課) that maps to a section, so
 * they cannot appear in any row of the table below. Calling this "丢失" would send an
 * operator hunting for missing data that is in fact present and counted.
 *
 * Not rendered as an error. A real day measured 35 rows / 231 h of support staff with
 * no section - that is the steady state, not an incident.
 */
function UnattributedBanner({
  monthLabel,
  rows,
  hours,
  groups,
}: {
  monthLabel: string;
  rows: number;
  hours: number;
  groups: readonly { hrDeptName: string; hrSectionName: string | null; rowCount: number; totalHours: number }[];
}): ReactElement {
  if (rows === 0) {
    return (
      <div className="rounded-lg bg-card px-4 py-3 text-sm text-muted-foreground ring-1 ring-border">
        {monthLabel}:全部考勤行都已归属到课,无未归属工时。
      </div>
    );
  }

  return (
    <section className="rounded-lg bg-challenge/10 p-4 ring-1 ring-challenge/30">
      <h2 className="font-heading text-sm font-semibold text-foreground">
        {monthLabel} 未归属工时:{rows} 行 / {formatHoursValue(hours)} H
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        这些工时已按 D-118 全额计入公司合计,但其(部,課)在组织表中没有对应的课,
        因此不出现在下方任何一行——下方各课合计会小于公司合计,差额即为此处数字。
        如需归属,请在管理页维护课别别名(SectionAlias)。
      </p>
      <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
        {groups.map((group) => (
          <li
            key={`${group.hrDeptName}#${group.hrSectionName ?? ""}`}
            className="flex items-baseline justify-between gap-3 rounded-md bg-card/70 px-3 py-1.5 ring-1 ring-border"
          >
            <span className="truncate">
              {group.hrDeptName === "" ? "（空）" : group.hrDeptName}
              {" / "}
              {group.hrSectionName === null || group.hrSectionName === ""
                ? "（无课别）"
                : group.hrSectionName}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {group.rowCount} 行 · {formatHoursValue(group.totalHours)} H
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Month picker for the unattributed banner. Only months with data are offered. */
function MonthTabs({
  fiscalYear,
  months,
  activeMonth,
}: {
  fiscalYear: number;
  months: readonly number[];
  activeMonth: number;
}): ReactElement {
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label="未归属工时统计月份">
      {months.map((month) => {
        const isActive = month === activeMonth;
        return (
          <a
            key={month}
            href={`/actuals?fy=${fiscalYear}&month=${month}`}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background tabular-nums"
                : "rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground tabular-nums ring-1 ring-border transition-colors hover:bg-muted/70"
            }
          >
            {fiscalMonthLabel(fiscalYear, month)}
          </a>
        );
      })}
    </nav>
  );
}

export default async function ActualsPage({
  searchParams,
}: {
  // Next 16 made searchParams a Promise. Typing it as a plain object still compiles -
  // the generated route validator widens the prop bag with `& any` - but
  // `searchParams?.fy` then reads a property off a Promise and is always undefined,
  // silently pinning the page to the current fiscal year. It has to be awaited.
  searchParams?: Promise<{ fy?: string; month?: string }>;
}): Promise<ReactElement> {
  const [years, current, snapshot, importLogs, latestSuccess, resolvedSearchParams] =
    await Promise.all([
      findAllFiscalYears(),
      findCurrentFiscalYear(),
      loadOrgSnapshot(),
      findRecentImportLogs(IMPORT_HISTORY_LIMIT),
      // Its own query rather than a scan of importLogs above. That list is capped at
      // IMPORT_HISTORY_LIMIT attempts of any status, so a run of failures longer than the
      // window would push the last success out of it - and reading "no success in these 10
      // rows" as "never imported" would report the wrong problem at exactly the moment the
      // pipeline is worst.
      findLatestSuccessfulImportLog(),
      searchParams,
    ]);

  // Read once and threaded down, not called inside the panel: two `new Date()` calls in one
  // render can straddle midnight, and a page that says "3 天" in the banner and "2 天" in the
  // table below is worse than either number alone.
  const staleness = describeImportStaleness(latestSuccess?.importedAt ?? null, new Date());

  const fiscalYear = pickFiscalYear(years, current, resolvedSearchParams?.fy);
  // Sequential on purpose: the actuals query needs the resolved year id, so it cannot
  // join the batch above.
  const actuals = fiscalYear === null ? [] : await findActualsByFiscalYear(fiscalYear.id);
  const view = fiscalYear === null ? null : buildActualsView(snapshot, actuals, fiscalYear);

  const focusMonth =
    view === null ? null : pickFocusMonth(view.monthsWithData, resolvedSearchParams?.month);
  // Also sequential, and also unavoidable: the month has to be resolved from the view
  // above before the unattributed bucket can be recomputed for it.
  const unattributed =
    fiscalYear === null || focusMonth === null
      ? null
      : await findUnattributedHours({ fiscalYear: fiscalYear.year, month: focusMonth });

  const focusTotal =
    view === null || focusMonth === null
      ? 0
      : (view.monthTotals[focusMonth - 1]?.totalHours ?? 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-full space-y-4 px-6 py-6">
          <div className="flex items-center justify-between gap-6">
            <MainNav active="actuals" />
            <span className="text-xs text-muted-foreground">
              {fiscalYear === null ? "未设置财年" : fiscalYear.name} · 内网免登录
            </span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">实绩工时</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                由每日考勤数据按 D-110 三公式折算并按(部,課)聚合而来。
                空白格表示该月尚未导入,与导入后为 0 是两件事。
              </p>
            </div>
            {/* In the header rather than as a fifth MainNav item: the nav lists the four
                screens the work flows through, and an upload action is a task on this
                screen, not a peer of 看板/实绩/计划录入/管理. */}
            <a
              href="/actuals/import"
              className="inline-flex shrink-0 items-center rounded-md bg-actual px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-actual/90"
            >
              导入考勤数据 →
            </a>
          </div>
          {years.length > 0 ? (
            <YearTabs years={years} activeYear={fiscalYear?.year ?? 0} />
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-full space-y-6 px-6 py-8">
        {fiscalYear === null || view === null ? (
          <EmptyYearState />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="有数据的课"
                value={`${view.sectionsWithData} / ${snapshot.sections.length}`}
                tone={
                  view.sectionsWithData > 0 && view.sectionsWithData < snapshot.sections.length
                    ? "warn"
                    : "normal"
                }
              />
              <Stat label="有数据的月份" value={`${view.monthsWithData.length} / 12`} />
              <Stat label="人员工时合计" value={formatHoursValue(view.personnelTotal)} />
              <Stat label="总工时合计" value={formatHoursValue(view.total)} />
            </div>

            <ImportStatusPanel logs={importLogs} staleness={staleness} />

            {view.monthsWithData.length === 0 ? (
              <NoActualsState fiscalYearName={fiscalYear.name} />
            ) : (
              <>
                {focusMonth !== null && unattributed !== null ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <MonthTabs
                        fiscalYear={fiscalYear.year}
                        months={view.monthsWithData}
                        activeMonth={focusMonth}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {fiscalMonthLabel(fiscalYear.year, focusMonth)} 各课合计{" "}
                        {formatHoursValue(focusTotal)} H
                      </span>
                    </div>
                    <UnattributedBanner
                      monthLabel={fiscalMonthLabel(fiscalYear.year, focusMonth)}
                      rows={unattributed.rows}
                      hours={unattributed.hours}
                      groups={unattributed.groups}
                    />
                  </div>
                ) : null}

                <section className="overflow-x-auto rounded-lg bg-card ring-1 ring-border">
                  <table className="w-full min-w-[64rem] text-sm">
                    <caption className="sr-only">
                      {fiscalYear.name} 各课 12 个月总工时,按部门分组,末列为课合计
                    </caption>
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                        <th scope="col" className="sticky left-0 bg-card px-4 py-2.5 text-left font-semibold">
                          部 / 課
                        </th>
                        {view.monthLabels.map((label) => (
                          <th key={label} scope="col" className="px-2 py-2.5 text-right font-semibold tabular-nums">
                            {label}
                          </th>
                        ))}
                        <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                          合计
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map((row, index) => {
                        // The department cell repeats only on its first section, which
                        // is what makes the grouping readable without a nested table.
                        const isFirstOfDepartment =
                          view.rows[index - 1]?.departmentId !== row.departmentId;
                        return (
                          <tr
                            key={row.sectionId}
                            className={`border-b border-border/60 last:border-0 ${
                              isFirstOfDepartment && index > 0 ? "border-t border-border" : ""
                            }`}
                          >
                            <th
                              scope="row"
                              className="sticky left-0 bg-card px-4 py-2 text-left font-normal whitespace-nowrap"
                            >
                              {isFirstOfDepartment ? (
                                <span className="text-muted-foreground">
                                  {row.departmentName} /{" "}
                                </span>
                              ) : (
                                // Visually the 部 is implied by position, but a row read
                                // in isolation would name only the 課 - so it is supplied
                                // to screen readers instead of repeated on screen.
                                <span className="sr-only">{row.departmentName} / </span>
                              )}
                              <span className="font-medium">{row.sectionName}</span>
                            </th>
                            {row.cells.map((cell) => (
                              <td
                                key={cell.month}
                                className={`px-2 py-2 text-right tabular-nums ${
                                  cell.present ? "" : "text-muted-foreground/40"
                                }`}
                                title={
                                  cell.present
                                    ? `人员 ${formatHoursValue(cell.personnelHours)} H · 加班 ${formatHoursValue(cell.overtimeHours)} H`
                                    : "尚未导入"
                                }
                              >
                                {cell.present ? formatHoursValue(cell.totalHours) : "—"}
                              </td>
                            ))}
                            <td className="px-4 py-2 text-right font-medium tabular-nums">
                              {formatHoursValue(row.total)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/40 text-sm font-medium">
                        <th scope="row" className="sticky left-0 bg-muted/40 px-4 py-2.5 text-left">
                          各课合计
                        </th>
                        {view.monthTotals.map((month) => (
                          <td key={month.month} className="px-2 py-2.5 text-right tabular-nums">
                            {month.sectionsWithData === 0 ? "—" : formatHoursValue(month.totalHours)}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatHoursValue(view.total)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </section>

                <p className="text-xs text-muted-foreground">
                  单元格显示总工时,悬停可见人员工时与加班工时。加班工时可为负数
                  (调休抵扣超过加班),按 D-110 原样保留不截断。
                  重复导入同一天为幂等覆盖(D-122),不会累加。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
