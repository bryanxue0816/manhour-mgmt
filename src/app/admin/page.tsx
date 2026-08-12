/**
 * /admin - master-data screen.
 *
 * A Server Component that reads the repository layer directly (no API route), then
 * hands the two editable domains to client editors that call the Server Actions in
 * ./actions.ts. Four blocks: organisation hierarchy (editable), fiscal years
 * (read-only), job-title rules (editable) and config key/values (read-only).
 *
 * Fiscal years and config stay read-only for different reasons. A fiscal year carries
 * `isCurrent` and 288 plan rows keyed to it, so editing one from a table cell would
 * need its own guarded flow. Config currently has exactly one key and no consumer at
 * all (see D-169), so an edit form would let an administrator change a value that
 * nothing reads - worse than no form.
 *
 * `force-dynamic` is mandatory: without it Next would try to prerender this route
 * at build time and open a database connection on a machine that has no dev.db,
 * failing the build.
 */
import type { ReactElement, ReactNode } from "react";

import { getAllConfig } from "@/lib/db/config.repo";
import { MainNav } from "@/components/layout/MainNav";
import { formatDateOnly } from "@/lib/db/date";
import { findAllFiscalYears } from "@/lib/db/fiscal-year.repo";
import { findAllJobTitleRules } from "@/lib/db/job-title-rule.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import { countPlansByFiscalYear } from "@/lib/db/plan.repo";
import type { FiscalYearDto } from "@/lib/db/types";
import { KvTable, type KvColumn } from "./_components/KvTable";
import { JobTitleRuleEditor } from "./_components/JobTitleRuleEditor";
import { OrgEditor } from "./_components/OrgEditor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "主数据管理 | 工时管理系统",
  description: "组织结构、财年、职位规则与系统配置的查看与维护",
};

/** A fiscal year plus its plan row count, resolved in one parallel pass. */
interface FiscalYearRow extends FiscalYearDto {
  planCount: number;
}

/** One config entry as a table row. */
interface ConfigRow {
  key: string;
  value: string;
}

/** A complete fiscal year holds 12 months x 24 sections of plan rows. */
const EXPECTED_PLAN_ROWS = 288;

/**
 * Loads plan counts for every fiscal year concurrently.
 *
 * `Promise.all` rather than a sequential loop: the counts are independent, and
 * the year list is small and bounded, so one round-trip per year in parallel is
 * cheaper than N serialised awaits.
 */
async function loadFiscalYearRows(): Promise<readonly FiscalYearRow[]> {
  const years = await findAllFiscalYears();
  return Promise.all(
    years.map(async (year) => ({
      ...year,
      planCount: await countPlansByFiscalYear(year.id),
    })),
  );
}

/** Section shell: heading + optional anchor line + bordered content surface. */
function Block({
  title,
  anchor,
  hint,
  children,
}: {
  title: string;
  anchor: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
        <span className="rounded-full bg-plan/10 px-2.5 py-0.5 text-xs font-medium text-plan tabular-nums">
          {anchor}
        </span>
        {hint !== undefined ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border">{children}</div>
    </section>
  );
}

const FISCAL_YEAR_COLUMNS: readonly KvColumn<FiscalYearRow>[] = [
  {
    key: "name",
    header: "财年",
    cell: (row) => (
      <span className="inline-flex items-center gap-2">
        <span className="font-semibold">{row.name}</span>
        {row.isCurrent ? (
          <span className="inline-flex items-center rounded-full bg-challenge/15 px-2 py-0.5 text-xs font-medium text-challenge">
            当前财年
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: "year",
    header: "年度",
    align: "right",
    className: "tabular-nums",
    cell: (row) => row.year,
  },
  {
    key: "range",
    header: "起止日期",
    cell: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatDateOnly(row.startDate)} → {formatDateOnly(row.endDate)}
      </span>
    ),
  },
  {
    key: "planCount",
    header: "Plan 行数",
    align: "right",
    className: "tabular-nums",
    cell: (row) => (
      <span
        className={
          row.planCount === EXPECTED_PLAN_ROWS
            ? "font-medium text-foreground"
            : "font-medium text-warn"
        }
      >
        {row.planCount}
      </span>
    ),
  },
];

const CONFIG_COLUMNS: readonly KvColumn<ConfigRow>[] = [
  {
    key: "key",
    header: "键",
    className: "w-64 font-mono text-xs font-medium",
    cell: (row) => row.key,
  },
  {
    key: "value",
    header: "值",
    className: "font-mono text-xs",
    cell: (row) => row.value,
  },
];

export default async function AdminPage(): Promise<ReactElement> {
  // Independent reads - fired together so the page waits on the slowest, not the sum.
  const [snapshot, fiscalYears, jobTitleRules, config] = await Promise.all([
    loadOrgSnapshot(),
    loadFiscalYearRows(),
    findAllJobTitleRules(),
    getAllConfig(),
  ]);

  const configRows: readonly ConfigRow[] = Object.entries(config).map(([key, value]) => ({
    key,
    value,
  }));
  const currentFiscalYear = fiscalYears.find((year) => year.isCurrent);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div className="mb-5 flex items-center justify-between gap-6">
            <MainNav active="admin" />
            <span className="text-xs text-muted-foreground">
              {currentFiscalYear === undefined ? "未设置财年" : currentFiscalYear.name} · 内网免登录
            </span>
          </div>
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            Master Data
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">主数据管理</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            组织结构与职位规则可在本页直接维护；财年与系统配置为只读。
            部/课的名称、以及部课的删除不在本页范围内——名称是组织数据的自然键，
            相关变更请通过 Excel 导入流程完成。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-10 px-6 py-8">
        <Block
          title="组织结构"
          anchor={`${snapshot.departments.length} 个部门 / ${snapshot.sections.length} 个课`}
          hint="排序、责任者、邮箱与部门编码可编辑；名称与删除不可"
        >
          <OrgEditor departments={snapshot.departments} sections={snapshot.sections} />
        </Block>

        <Block
          title="财年"
          anchor={`${fiscalYears.length} 个财年`}
          hint={`完整财年应有 ${EXPECTED_PLAN_ROWS} 条 Plan`}
        >
          <KvTable
            columns={FISCAL_YEAR_COLUMNS}
            rows={fiscalYears}
            rowKey={(row) => row.id}
            emptyLabel="暂无财年数据"
          />
        </Block>

        <Block
          title="职位规则"
          anchor={`${jobTitleRules.length} 条规则`}
          hint="仅登记需要排除的职位，未登记职位视为全部计入"
        >
          <JobTitleRuleEditor rules={jobTitleRules} />
        </Block>

        <Block title="系统配置" anchor={`${configRows.length} 项配置`} hint="只读">
          <KvTable
            columns={CONFIG_COLUMNS}
            rows={configRows}
            rowKey={(row) => row.key}
            emptyLabel="暂无配置项"
          />
        </Block>
      </main>
    </div>
  );
}
