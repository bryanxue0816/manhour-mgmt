/**
 * D-198's dashboard caption: some months' actuals were typed in by hand.
 *
 * A Server Component rendered through DashboardClient's `banner` slot, exactly as
 * ImportStalenessBanner is - which keeps the month list and the fiscal-label helper off
 * the browser bundle, and needs no change to the client component (its `banner` prop is
 * documented as taking a second class of warning).
 *
 * Placed ABOVE the KPI row for the reason that prop already gives: a caveat printed after
 * the numbers is read after they have been believed. What it has to prevent is a specific
 * misreading - months predating go-live carry the whole month in 总工时 with 人员工时 and
 * 加班工时 at 0, because that split comes from per-employee columns those months never had.
 * On the chart the 实绩 total line is correct there while any personnel/overtime breakdown
 * is an undercount, and 0 加班 for a whole 制造部 month reads as a fact rather than as
 * "unavailable".
 *
 * AMBER, not destructive red. Nothing is broken and nothing needs fixing: these figures
 * are the best that exists for those months and 「剩余 = 计划 − 实绩」 (D-141) holds on them
 * unchanged. The red banner directly above means "go import the missing days"; spending
 * the same colour here would send the operator looking for a problem that has no action.
 */
import type { ReactElement } from "react";

import { ACTUAL_SOURCE_LABELS } from "@/lib/db/actual-source";
import { fiscalMonthLabel } from "@/lib/db/date";

export function ManualBaselineNote({
  months,
  fiscalYearStartYear,
}: {
  months: readonly number[];
  fiscalYearStartYear: number | null;
}): ReactElement | null {
  // No manual months is the ordinary state, so it renders nothing rather than a
  // "全部来自考勤" reassurance - same reasoning as the staleness banner's silent OK.
  //
  // A null start year means the tree degraded to the mock. Its months are FY2026
  // fixtures, so labelling them with a real year would misdate demo data (D-165); and a
  // provenance note on demo numbers names the wrong problem anyway, which is why
  // loadDashboardOrg() returns an empty list on every degraded path. Checked here too
  // because the label below cannot be built without the year.
  if (months.length === 0 || fiscalYearStartYear === null) {
    return null;
  }

  const labels = months
    .map((month) => fiscalMonthLabel(fiscalYearStartYear, month))
    .join("、");

  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
      {/* Decorative; the sentence carries the meaning on its own. */}
      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
      <p className="text-sm text-amber-900">
        <span className="font-medium">
          {labels} 为{ACTUAL_SOURCE_LABELS.manual}：
        </span>
        这些月份早于系统上线,实绩按「每月 × 每课 合计」由管理员手工录入,
        <span className="font-medium">总工时可信</span>,
        但人员工时与加班工时无法拆分(显示为 0 表示「无数据」,不是「没有加班」)。
        计划对比与「剩余 = 计划 − 实绩」不受影响。明细见{" "}
        <a href="/actuals" className="font-medium underline hover:no-underline">
          实绩工时页
        </a>
        。
      </p>
    </div>
  );
}
