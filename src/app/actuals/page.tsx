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
 * The grid reports 实绩 = 折算 + 未撤销的调整单 (D-233), read through
 * `findEffectiveActualsByFiscalYear`. The provenance panels below it keep reading the
 * plain fold, which is the right answer for them: they reconcile against imported
 * attendance rows, and a hand-tallied slip has none.
 *
 * `force-dynamic` is mandatory for the same reason as /plans and /admin: without it
 * Next tries to prerender the route at build time and opens a database connection on
 * a machine that has no dev.db, failing the build.
 */
import type { ReactElement } from "react";

import { MainNav } from "@/components/layout/MainNav";
import type { ActualsCell, ActualsDriftRef, ActualsMonthTotal } from "@/lib/attendance/actuals-view";
import { buildActualsView } from "@/lib/attendance/actuals-view";
import {
  describeImportStaleness,
  type ImportStaleness,
} from "@/lib/attendance/import-staleness";
import { requireAdminPage } from "@/lib/auth-page";
import { findEffectiveActualsByFiscalYear } from "@/lib/db/actual-effective.repo";
import { ACTUAL_SOURCE_LABELS } from "@/lib/db/actual-source";
import { findUnattributedHours } from "@/lib/db/attendance.repo";
import { fiscalMonthLabel, formatBusinessTimestamp } from "@/lib/db/date";
import { findAllFiscalYears, findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";
import { IMPORT_STATUS_LABELS, IMPORT_TRIGGER_LABELS } from "@/lib/db/import-labels";
import { findLatestSuccessfulImportLog, findRecentImportLogs } from "@/lib/db/import-log.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import type { FiscalYearDto, ImportLogDto } from "@/lib/db/types";
import { formatHoursValue, formatSignedHours } from "@/lib/format";

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

/**
 * Hover text for one grid cell, assembled from clauses because a cell can be several
 * things at once: 尚未导入, a normal fold, a 手工基线 month, and any of those carrying a
 * 调整单 on top.
 *
 * A manual baseline row gets its own wording rather than the usual 人员/加班 breakdown
 * because those two numbers are 0 for it - the split comes from per-employee columns that
 * do not exist for months predating go-live (D-198). Showing "人员 0 H · 加班 0 H" next to
 * a five-figure total would state as fact something the data cannot support: that the
 * section logged no overtime.
 *
 * The displayed figure is 实绩 (fold + slips), so the tooltip is the only place the fold
 * and the adjustment are visible apart. That makes it load-bearing rather than decorative:
 * without it, a corrected cell and an uncorrected one differ by a single small glyph.
 */
function cellTitle(cell: ActualsCell): string {
  if (!cell.present) {
    return "尚未导入";
  }
  return [foldTitle(cell), ...adjustmentTitleLines(cell)].join(" ｜ ");
}

/** The fold half of the hover text - unchanged wording, now one clause of possibly three. */
function foldTitle(cell: ActualsCell): string {
  if (cell.isManualBaseline) {
    return (
      `${ACTUAL_SOURCE_LABELS.manual} · 不可拆分 — 月合计 ` +
      `${formatHoursValue(cell.totalHours)} H(人员工时 / 加班工时 未分拆)`
    );
  }
  return (
    `${ACTUAL_SOURCE_LABELS.fold} — 人员 ${formatHoursValue(cell.personnelHours)} H · ` +
    `加班 ${formatHoursValue(cell.overtimeHours)} H`
  );
}

/**
 * The 调整单 clauses, empty when the cell has none (D-233).
 *
 * `adjustmentHours` is signed and formatted with an explicit sign, because "调整 300" and
 * "调整 -300" differ by 600 H and a dropped minus in a tooltip is unrecoverable by eye.
 * The drift clause is worded as suspicion, not as a verdict: the read side compares the
 * fold against the base recorded when the slip was written and cannot tell a legitimate
 * re-fold from the 8月 double-count, so it says which and lets a human decide.
 */
function adjustmentTitleLines(cell: ActualsCell): readonly string[] {
  if (cell.adjustmentHours === 0 && !cell.foldChangedSinceAdjustment) {
    return [];
  }
  const lines = [
    `调整单 ${formatSignedHours(cell.adjustmentHours)} H → 实绩 ` +
      `${formatHoursValue(cell.effectiveHours)} H`,
  ];
  if (cell.foldChangedSinceAdjustment) {
    lines.push("⚠ 折算工时在调整单录入后发生变化,请核对是否重复计入");
  }
  return lines;
}

/**
 * Hover text for one month total, or `undefined` when there is nothing to explain.
 *
 * Returning `undefined` rather than a generic string matters: a `title` on every footer
 * cell trains the reader to ignore all of them, and the two cases here (手工基线,
 * 调整单) are the only ones where the displayed number needs a caveat.
 */
function monthTotalTitle(month: ActualsMonthTotal): string | undefined {
  const parts: string[] = [];
  if (month.hasManualBaseline) {
    parts.push(`本月含${ACTUAL_SOURCE_LABELS.manual}数据,人员工时 / 加班工时 合计偏低`);
  }
  if (month.adjustmentHours !== 0) {
    parts.push(
      `折算 ${formatHoursValue(month.totalHours)} H ＋ 调整单 ` +
        `${formatSignedHours(month.adjustmentHours)} H`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ｜ ");
}

/**
 * Absolute business-zone timestamp, or a placeholder when the source row has none.
 *
 * The zone comes from formatBusinessTimestamp rather than the host clock: an import
 * timestamp that silently shifts on a UTC server would misdate the whole import-health
 * panel, and that panel exists to answer "is this table stale?" (D-189).
 */
function formatTimestamp(value: Date | null): string {
  if (value === null) {
    return "（未知）";
  }
  return formatBusinessTimestamp(value);
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
  hint,
  tone = "normal",
}: {
  label: string;
  value: string;
  /** Second line under the figure - used to show what a composed total is made of. */
  hint?: string;
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
      {hint === undefined ? null : (
        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">{hint}</div>
      )}
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
  // D-222: a too-early export lands as SUCCESS, so this cannot ride on `isBad` and cannot
  // read only the latest row. The point of the warning is that the day looks fine
  // everywhere else - if it is not called out here, the missing hours are invisible until
  // someone compares the month against a payroll figure.
  const warnedLogs = logs.filter(
    (log): log is ImportLogDto & { warningMessage: string } => log.warningMessage !== null,
  );

  return (
    <section className="rounded-lg bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-heading text-base font-semibold">导入状态</h2>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ${
            isBad ? "bg-warn/15 text-warn" : "bg-muted text-muted-foreground"
          }`}
        >
          最近一次:{IMPORT_STATUS_LABELS[latest.status]} · {formatTimestamp(latest.importedAt)}
        </span>
      </div>

      {isBad ? (
        <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-sm text-foreground ring-1 ring-warn/30">
          最近一次导入未完全成功,下方实绩数据可能不是最新的。
          {latest.errorMessage === null ? "" : `错误:${latest.errorMessage}`}
        </p>
      ) : null}

      {warnedLogs.length === 0 ? null : (
        <div
          role="alert"
          className="mt-3 space-y-2 rounded-md bg-warn/10 px-3 py-2 text-sm text-foreground ring-1 ring-warn/30"
        >
          <p className="font-medium">
            最近 {logs.length} 次导入中有 {warnedLogs.length} 次疑似导出过早,对应日期的工时可能不完整
          </p>
          <ul className="space-y-1.5">
            {warnedLogs.map((log) => (
              <li key={log.id} className="leading-relaxed">
                <span className="font-medium">{log.fileName}</span>
                <span className="mt-0.5 block text-muted-foreground">{log.warningMessage}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                      {IMPORT_STATUS_LABELS[log.status]}
                    </span>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                    {formatTimestamp(log.importedAt)}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {IMPORT_TRIGGER_LABELS[log.triggeredBy]}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{log.rowCount}</td>
                  <td className="max-w-[18rem] py-2 pr-3 align-top">
                    <span className="block truncate" title={log.fileName}>
                      {log.fileName}
                    </span>
                    {log.warningMessage === null ? null : (
                      // Marker only; the sentence is in the banner above. Repeating it per
                      // row would push 行数 and 文件时间 out of view, and those are what
                      // someone scans to find the day in question.
                      <span className="mt-0.5 block text-xs text-warn">疑似导出过早</span>
                    )}
                  </td>
                  <td className="py-2 align-top tabular-nums text-muted-foreground">
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

/**
 * Section-months whose 折算 moved after a 调整单 was written against them (D-233).
 *
 * Renders nothing in the normal case, and that is the point: a banner that is always
 * present is a banner nobody reads. It names the section-months instead of counting them,
 * because "3 处存在差异" sends the reader hunting through a 24 x 12 grid for cells that
 * carry no other visual difference.
 *
 * The wording stops at 提示. The read side knows only that the fold no longer equals the
 * base recorded at entry time - which is exactly what a legitimate re-import and the 8月
 * double-count look like from here. Auto-correcting would silently rewrite hand-tallied
 * figures on the strength of a guess.
 */
function FoldDriftBanner({ cells }: { cells: readonly ActualsDriftRef[] }): ReactElement | null {
  if (cells.length === 0) {
    return null;
  }
  return (
    <section role="alert" className="rounded-lg bg-warn/10 p-4 ring-1 ring-warn/40">
      <h2 className="font-heading text-sm font-semibold text-foreground">
        <span aria-hidden="true" className="mr-1">
          ⚠
        </span>
        {cells.length} 个(課, 月)的折算工时在调整单录入后发生了变化
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        录入调整单时,系统记录了当时的折算工时作为基数。这些格子的折算工时之后被重新计算过
        (例如补导入了更早日期的考勤数据),因此调整单可能已经重复计入。
        请逐个核对:若折算工时已包含调整单补录的部分,应撤销对应的调整单。
        系统不会自动修正——它无法区分「合理的重新折算」与「重复计入」。
      </p>
      <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {cells.map((cell) => (
          <li
            key={`${cell.sectionId}#${cell.month}`}
            className="rounded-md bg-card/70 px-2 py-1 ring-1 ring-border"
          >
            {cell.sectionName} · {cell.label}
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
  await requireAdminPage("/actuals");

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
  //
  // Read through the effective-actuals composition, not `findActualsByFiscalYear`: this
  // screen is the one place 实绩 is reported per (課, 月), so it has to report the fold
  // PLUS un-revoked 调整单 (D-233). The plain fold stays correct for the
  // attendance-provenance panels below, which reconcile against imported detail.
  const effective =
    fiscalYear === null ? null : await findEffectiveActualsByFiscalYear(fiscalYear.id);
  const view =
    fiscalYear === null || effective === null
      ? null
      : buildActualsView(snapshot, effective.rows, fiscalYear);
  // Slip-driven, not derived from `adjustmentHours !== 0`: two live slips of +300 and
  // -300 net to zero, and a month whose figures were hand-corrected must still say so.
  const adjustedMonths = effective?.adjustedMonths ?? [];

  const focusMonth =
    view === null ? null : pickFocusMonth(view.monthsWithData, resolvedSearchParams?.month);
  // Also sequential, and also unavoidable: the month has to be resolved from the view
  // above before the unattributed bucket can be recomputed for it.
  const unattributed =
    fiscalYear === null || focusMonth === null
      ? null
      : await findUnattributedHours({ fiscalYear: fiscalYear.year, month: focusMonth });

  // Deliberately the FOLD total, not the effective one. This number sits next to the
  // unattributed banner, whose job is to reconcile the section rows against the imported
  // attendance detail for the month; hand-tallied 调整单 hours have no attendance rows
  // behind them, so adding them here would make a balanced month look short by exactly
  // the adjustment (D-233).
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
              {fiscalYear === null ? "未设置财年" : fiscalYear.name} · 管理员已登录
            </span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">实绩工时</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                由每日考勤数据按 D-110 三公式折算并按(部,課)聚合而来,再叠加人工调整单
                (D-233)。空白格表示该月尚未导入,与导入后为 0 是两件事。
              </p>
            </div>
            {/* In the header rather than as a fifth MainNav item: the nav lists the four
                screens the work flows through, and an upload action is a task on this
                screen, not a peer of 看板/实绩/计划录入/管理. The same reasoning puts 调整单
                here - it is a correction to the figures on THIS table, reached from them. */}
            <div className="flex shrink-0 items-center gap-2">
              <a
                href="/actuals/adjust"
                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
              >
                实绩调整单 →
              </a>
              <a
                href="/actuals/import"
                className="inline-flex items-center rounded-md bg-actual px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-actual/90"
              >
                导入考勤数据 →
              </a>
            </div>
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
              {/* The headline figure is 实绩 = 折算 + 调整 (D-233). The breakdown appears
                  only when slips exist, so an un-adjusted year keeps the single number it
                  had before and nobody has to learn a decomposition that reads "+0". */}
              <Stat
                label="实绩合计"
                value={formatHoursValue(view.effectiveTotal)}
                hint={
                  adjustedMonths.length === 0
                    ? undefined
                    : `折算 ${formatHoursValue(view.total)} ＋ 调整 ` +
                      `${formatSignedHours(view.adjustmentTotal)}`
                }
              />
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

                <FoldDriftBanner cells={view.foldDriftCells} />

                <section className="overflow-x-auto rounded-lg bg-card ring-1 ring-border">
                  <table className="w-full min-w-[64rem] text-sm">
                    <caption className="sr-only">
                      {fiscalYear.name} 各课 12 个月实绩工时(折算 + 调整单),按部门分组,末列为课合计
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
                                title={cellTitle(cell)}
                              >
                                {/* 实绩 = 折算 + 调整单 (D-233). The fold alone is one hover
                                    away; showing it here would put a number on screen that
                                    no downstream figure - not 剩余, not 达成率 - agrees with. */}
                                {cell.present ? formatHoursValue(cell.effectiveHours) : "—"}
                                {cell.isManualBaseline ? (
                                  <>
                                    {/* The glyph is decorative - hidden from screen
                                        readers, which get the words instead, because
                                        "asterisk" read aloud carries no meaning. */}
                                    <span aria-hidden="true" className="ml-0.5 text-amber-600">
                                      ※
                                    </span>
                                    <span className="sr-only">（手工基线）</span>
                                  </>
                                ) : null}
                                {/* A different glyph AND a different colour from ※ on
                                    purpose: 手工基线 is about a whole month's provenance,
                                    a 调整单 is one hand-entered correction on top of an
                                    otherwise normal fold. One marker for both would make
                                    the footnotes unreadable. */}
                                {cell.adjustmentHours !== 0 ? (
                                  <>
                                    <span aria-hidden="true" className="ml-0.5 text-plan">
                                      △
                                    </span>
                                    <span className="sr-only">（含调整单）</span>
                                  </>
                                ) : null}
                                {cell.foldChangedSinceAdjustment ? (
                                  <>
                                    <span aria-hidden="true" className="ml-0.5 text-warn">
                                      ⚠
                                    </span>
                                    <span className="sr-only">（折算工时已变化,待核对）</span>
                                  </>
                                ) : null}
                              </td>
                            ))}
                            <td className="px-4 py-2 text-right font-medium tabular-nums">
                              {formatHoursValue(row.effectiveTotal)}
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
                          <td
                            key={month.month}
                            className="px-2 py-2.5 text-right tabular-nums"
                            title={monthTotalTitle(month)}
                          >
                            {month.sectionsWithData === 0
                              ? "—"
                              : formatHoursValue(month.effectiveHours)}
                            {month.hasManualBaseline ? (
                              <span aria-hidden="true" className="ml-0.5 text-amber-600">
                                ※
                              </span>
                            ) : null}
                            {/* Driven by the month's own figures, unlike the footnote below,
                                which is slip-driven. A net-zero month therefore carries no
                                glyph here and is still named in the footnote - correct in
                                both places: nothing in this column moved, yet the month was
                                edited by hand. */}
                            {month.adjustmentHours !== 0 ? (
                              <span aria-hidden="true" className="ml-0.5 text-plan">
                                △
                              </span>
                            ) : null}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatHoursValue(view.effectiveTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </section>

                {view.manualBaselineMonths.length > 0 ? (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                    <span aria-hidden="true" className="mr-1 font-medium">
                      ※
                    </span>
                    <span className="font-medium">
                      {ACTUAL_SOURCE_LABELS.manual}(
                      {view.manualBaselineMonths
                        .map((month) => fiscalMonthLabel(fiscalYear.year, month))
                        .join("、")}
                      )
                    </span>
                    ：这些月份早于系统上线,由管理员按「每月 × 每课 合计」手工录入,
                    只有总工时可信。人员工时与加班工时显示为 0 是「无法拆分」,不是「没有加班」,
                    其列合计因此偏低。总工时不受影响,
                    「剩余 = 计划 − 实绩」(D-141)照常成立。
                  </p>
                ) : null}

                {adjustedMonths.length > 0 ? (
                  <p className="rounded-md bg-plan/10 px-3 py-2 text-xs text-foreground ring-1 ring-plan/30">
                    <span aria-hidden="true" className="mr-1 font-medium text-plan">
                      △
                    </span>
                    <span className="font-medium">
                      含调整单(
                      {adjustedMonths
                        .map((month) => fiscalMonthLabel(fiscalYear.year, month))
                        .join("、")}
                      )
                    </span>
                    ：这些月份的实绩工时 = 折算工时 + 人工调整单。调整单用于补录系统抓取不到的部分
                    (例如只有按课合计的历史数据),或修正系统与人工统计的差异,
                    只记录总工时,不影响人员工时与加班工时的分拆。
                    悬停单元格可见「折算 / 调整 / 实绩」三个数字。
                    {view.adjustmentTotal === 0
                      ? "本年度调整单正负相抵,合计为 0——月份仍逐一列出,因为数字被人工改动过这件事本身需要可见。"
                      : ""}
                  </p>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  单元格显示实绩工时(折算 + 调整单),悬停可见明细。加班工时可为负数
                  (调休抵扣超过加班),按 D-110 原样保留不截断。
                  重复导入同一天为幂等覆盖(D-122),不会累加;调整单为独立记录,
                  重新折算不会覆盖它(D-233)。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
