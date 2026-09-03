/**
 * 实绩调整单 - the 24-課 comparison sheet (D-233).
 *
 * The screen's primary job is COMPARISON, not entry: an operator sits with a hand tally of
 * the closed month and reads it against what the system computed, 課 by 課. That is why all
 * 24 課 are listed even though only the differing ones get a slip - a sheet showing just
 * the rows the operator already knows about cannot be checked against anything.
 *
 * Three columns are load-bearing and none of them is optional:
 *
 *   * 折算 - what the attendance fold produced (or the D-198 hand-loaded baseline).
 *   * 已有调整 - the signed sum of un-revoked slips already filed on this (課, 月).
 *   * 当前实绩 - their sum, and the figure the new difference is measured against.
 *
 * 已有调整 is visible and non-collapsible because it is an ARITHMETIC PREREQUISITE. A fold
 * of 865 carrying an earlier +100 slip shows 965; a hand tally of 920 is 45 hours short of
 * what the system reports, not 55 hours over the raw fold. An operator who cannot see the
 * +100 has no way to know which subtraction the screen is doing.
 *
 * The month comes from the URL and is re-validated inside the Server Action against the
 * SERVER clock. This page picking a month is a convenience for the operator; it is not the
 * authority on which months may be written (see adjust-window.ts for the April
 * cross-fiscal-year and 00:00-08:00 traps that authority exists to contain).
 */
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { AdjustSheet } from "./_components/AdjustSheet";
import { RevokeSlipButton } from "./_components/RevokeSlipButton";
import { MainNav } from "@/components/layout/MainNav";
import { buildActualsView } from "@/lib/attendance/actuals-view";
import { buildAdjustDraftRows, type AdjustDraftRow } from "@/lib/attendance/adjust-draft";
import {
  listAdjustableMonths,
  resolveAdjustTarget,
  type AdjustableMonth,
} from "@/lib/attendance/adjust-window";
import { requireAdminPage } from "@/lib/auth-page";
import { findAllAdjustmentsByFiscalYear } from "@/lib/db/actual-adjustment.repo";
import { findEffectiveActualsByFiscalYear } from "@/lib/db/actual-effective.repo";
import { findFiscalYearByYear } from "@/lib/db/fiscal-year.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import type { ActualAdjustmentRow } from "@/lib/db/types";
import { formatHoursValue, formatSignedHours } from "@/lib/format";

/**
 * The sheet reads 実績 through findEffectiveActualsByFiscalYear, so a prerendered copy
 * would show whatever the build machine's database held - and the scheduled folds at
 * 09:05/15:05 move these figures during the working day.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "实绩调整单 | 工时管理",
  description: "按课对比人工统计与系统实绩，仅对有差额的课登记调整单。",
};

/** Timestamp format for the slip history. Fixed locale so the column width is stable. */
const STAMP = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Which month to work on.
 *
 * An unparseable or out-of-window `?month=` falls back to the default rather than erroring:
 * the parameter is a convenience, and a stale bookmark should land the operator on the
 * month they almost certainly want instead of on an error page.
 */
function pickMonth(
  months: readonly AdjustableMonth[],
  raw: string | undefined,
  fallback: AdjustableMonth,
): AdjustableMonth {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return months.find((month) => month.month === parsed) ?? fallback;
}

export default async function AdjustPage({
  searchParams,
}: {
  // Awaited, not read directly: Next 16 makes this a Promise, and reading `.month` off a
  // Promise compiles fine while always being undefined - the failure /actuals documents.
  searchParams?: Promise<{ month?: string }>;
}): Promise<ReactElement> {
  await requireAdminPage("/actuals/adjust");

  // One clock read for the whole render. Two calls could straddle midnight on the 1st of a
  // month and offer a month in the selector that the header says is out of range.
  const now = new Date();
  const target = resolveAdjustTarget(now);
  const months = listAdjustableMonths(now);

  const [resolvedSearchParams, snapshot, fiscalYear] = await Promise.all([
    searchParams,
    loadOrgSnapshot(),
    findFiscalYearByYear(target.fiscalYear),
  ]);

  const selected = pickMonth(months, resolvedSearchParams?.month, target);

  // Sequential: both reads need the resolved fiscal-year id.
  const effective = fiscalYear === null ? null : await findEffectiveActualsByFiscalYear(fiscalYear.id);
  const slips = fiscalYear === null ? [] : await findAllAdjustmentsByFiscalYear(fiscalYear.id);

  const rows: readonly AdjustDraftRow[] =
    fiscalYear === null || effective === null
      ? []
      : buildAdjustDraftRows(
          buildActualsView(snapshot, effective.rows, fiscalYear),
          selected.month,
        );

  // 課名 has to come from the sheet: a slip carries only sectionId, and a slip on a 課 that
  // was since removed from the org chart must still be listed - it is still in the totals.
  const sectionNames = new Map(rows.map((row) => [row.sectionId, row.sectionName]));

  // Revoked slips included on purpose (requirement 7 is "list what already exists", and a
  // figure that was filed, revoked, and re-filed differently is exactly what an operator
  // needs to see before filing another). Filtered here rather than in a new repo function:
  // one fiscal year holds at most a few hundred slips.
  const monthSlips = slips.filter((slip) => slip.month === selected.month);
  const liveSlipCount = monthSlips.filter((slip) => slip.revokedAt === null).length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-full space-y-4 px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <MainNav active="actuals" />
            <span className="text-xs text-muted-foreground">
              {fiscalYear === null ? "未设置财年" : fiscalYear.name} · 管理员已登录
            </span>
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">实绩调整单</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              把人工统计的月度工时逐课与系统实绩对比。<strong className="font-medium text-foreground">
              只填人工统计值,差额与正负号由系统计算</strong>;留空表示该课不调整,与填 0
              是两件事。调整只在次月进行,不影响当月的数据抓取。
            </p>
          </div>
          <a
            href="/actuals"
            className="inline-flex text-sm font-medium text-actual underline-offset-4 hover:underline"
          >
            ← 返回实绩工时
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-full space-y-6 px-6 py-8">
        {fiscalYear === null ? (
          <section className="rounded-lg border border-border bg-card p-6">
            <h2 className="font-heading text-base font-semibold">未找到财年</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              系统中没有 FY{target.fiscalYear} 的财年记录,无法登记 {target.calendarLabel}{" "}
              的调整单。请先在管理页建立该财年。
            </p>
          </section>
        ) : (
          <>
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                调整月份
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {months.map((month) => {
                  const isActive = month.month === selected.month;
                  return (
                    <a
                      key={month.month}
                      href={`/actuals/adjust?month=${String(month.month)}`}
                      aria-current={isActive ? "page" : undefined}
                      className={
                        isActive
                          ? "rounded-md bg-actual px-3 py-1.5 text-sm font-medium text-white"
                          : "rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-actual hover:text-foreground"
                      }
                    >
                      {month.calendarLabel}
                      <span className="ml-1.5 text-xs opacity-70">{month.fiscalLabel}</span>
                    </a>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                默认为上月({target.calendarLabel})。同财年更早的月份可以补录,当月及以后不能调整。
              </p>
            </section>

            {/* Requirement 7: what already exists, BEFORE anything new is filed. Filing a
                second slip for a difference already corrected is the mistake this panel
                exists to prevent, and the table has no unique key to catch it. */}
            <section className="rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h2 className="font-heading text-base font-semibold">
                  {selected.calendarLabel} 已有调整单
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    生效 {liveSlipCount} 张 / 共 {monthSlips.length} 张
                  </span>
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  已撤销的单据一并列出:同一课被登记、撤销、再改填过,是提交前必须先看到的事。
                </p>
              </div>
              {monthSlips.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  该月尚无调整单。下方表格的「已有调整」列因此全为 0。
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      {selected.calendarLabel} 已登记的实绩调整单,含已撤销的记录
                    </caption>
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="px-4 py-2 text-left font-medium">课</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">调整工时</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">原因</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">登记时间</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">状态</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthSlips.map((slip: ActualAdjustmentRow) => {
                        const isRevoked = slip.revokedAt !== null;
                        return (
                          <tr
                            key={slip.id}
                            data-slip-state={isRevoked ? "revoked" : "active"}
                            className={
                              isRevoked
                                ? "border-b border-border/60 text-muted-foreground"
                                : "border-b border-border/60"
                            }
                          >
                            <td className="px-4 py-2">
                              {sectionNames.get(slip.sectionId) ?? "（课别已删除）"}
                            </td>
                            <td
                              className={
                                isRevoked
                                  ? "px-4 py-2 text-right font-mono tabular-nums line-through"
                                  : "px-4 py-2 text-right font-mono tabular-nums"
                              }
                            >
                              {formatSignedHours(slip.hours)}
                            </td>
                            <td className="max-w-md px-4 py-2 text-xs">{slip.reason}</td>
                            <td className="whitespace-nowrap px-4 py-2 text-xs">
                              {STAMP.format(slip.changedAt)}
                            </td>
                            <td className="px-4 py-2 text-xs">
                              {isRevoked ? "已撤销" : "生效中"}
                            </td>
                            <td className="px-4 py-2 text-right">
                              {/* Revoked rows keep their place but lose the button: there
                                  is no un-revoke, so re-filing is the only way back. */}
                              {isRevoked ? null : (
                                <RevokeSlipButton
                                  id={slip.id}
                                  sectionName={sectionNames.get(slip.sectionId) ?? "该课"}
                                  hoursLabel={formatSignedHours(slip.hours)}
                                  monthLabel={selected.calendarLabel}
                                />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {rows.length === 0 ? (
              <section className="rounded-lg border border-border bg-card p-6">
                <h2 className="font-heading text-base font-semibold">没有可对比的课</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  组织架构中还没有课别,无法生成对比表。
                </p>
              </section>
            ) : (
              <AdjustSheet
                fiscalYear={selected.fiscalYear}
                month={selected.month}
                monthLabel={selected.calendarLabel}
                rows={rows}
                /* The fold total, for a quick eyeball against the bottom line of the hand
                   tally before any figure is typed. */
                baseTotal={formatHoursValue(
                  rows.reduce((sum, row) => sum + row.baseHours, 0),
                )}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
