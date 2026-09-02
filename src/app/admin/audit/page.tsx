// Audit trail viewer (D-183): the change logs the system already writes, made readable by
// the people who have to judge whether a change was legitimate.
//
// Three tabs rather than one merged stream: a plan-hours edit, an organisation rename and
// an attendance import answer different questions ("why did April go up?" / "when was this
// 课 renamed?" / "did today's data actually land?") and have genuinely different columns.
// Interleaving them would force a lowest-common-denominator table in which none of the
// three is easy to answer.
//
// The import tab (D-226) reads the same import_log that /actuals already renders, and that
// overlap is the point rather than an oversight. /actuals shows provenance while you are
// standing in front of the numbers; an operator whose question is "did the import succeed
// or fail" comes to the audit page, because that is an audit question. Organising the log
// only as 实绩数据的来源说明 was a mistake about where people look, not about the data.
//
// The master-data tab shows a snapshot summary, not a diff. See snapshot-summary.ts for
// why that restraint is deliberate.

import type { ReactElement } from "react";

import { MainNav } from "@/components/layout/MainNav";
import { requireAdminPage } from "@/lib/auth-page";
import { formatBusinessTimestamp } from "@/lib/db/date";
import { findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";
import { IMPORT_STATUS_LABELS, IMPORT_TRIGGER_LABELS } from "@/lib/db/import-labels";
import { countImportLogs, findImportLogPage } from "@/lib/db/import-log.repo";
import {
  countMasterDataChangeLogs,
  findMasterDataChangeLogs,
  type MasterDataChangeLogDto,
} from "@/lib/db/master-data-change-log.repo";
import {
  countPlanChangeLogsByFiscalYear,
  findPlanChangeLogPage,
  type PlanChangeLogRowDto,
} from "@/lib/db/plan-change-log.repo";
import type { ImportLogDto } from "@/lib/db/types";

import {
  AuditPager,
  AuditTabs,
  parseAuditTab,
  parsePageNumber,
  type AuditTab,
} from "./_components/AuditNav";
import { prettyPrintSnapshot, summariseSnapshot } from "./snapshot-summary";

/**
 * Without this Next would try to prerender at build time, which opens a database
 * connection on a machine that has no dev.db and fails the build. Same reason as
 * /admin.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "变更审计 | 工时管理系统",
  description: "计划工时、组织 / 职位规则的变更留痕与考勤数据导入履历",
};

/** Rows per page. Enough to scan a review session's worth of edits at once. */
const PAGE_SIZE = 30;

/** Shown wherever an optional reason was left blank (D-184). */
const NO_REASON = "未填写";

const FIELD_LABELS: Readonly<Record<string, string>> = {
  planned_hours: "计划工时",
  challenge_hours: "挑战工时",
};

const ENTITY_LABELS: Readonly<Record<string, string>> = {
  organization: "组织结构",
  job_title_rule: "职位规则",
  actual_baseline: "实绩基线",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  baseline: "初始基线",
  create: "新增",
  update: "修改",
  delete: "删除",
};

/**
 * Formats an instant for display, pinned to the business time zone.
 *
 * Kept as a local alias so the JSX below reads the same as before; the zone pinning
 * and the reasoning behind it now live in formatBusinessTimestamp (D-189), shared with
 * /actuals so neither call site can lose the `timeZone` option independently.
 */
function formatTimestamp(value: Date): string {
  return formatBusinessTimestamp(value);
}

/** Total pages, never below 1 so an empty trail still renders "第 1 / 1 页". */
function pageCountOf(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function labelOf(map: Readonly<Record<string, string>>, key: string): string {
  return map[key] ?? key;
}

/** Shared cell padding, so the two tables line up despite different columns. */
const TH = "px-4 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "px-4 py-2 align-top text-sm";

function EmptyRow({ span, text }: { span: number; text: string }): ReactElement {
  return (
    <tr>
      <td colSpan={span} className="px-4 py-10 text-center text-sm text-muted-foreground">
        {text}
      </td>
    </tr>
  );
}

function ReasonCell({ reason }: { reason: string | null }): ReactElement {
  return reason === null ? (
    <span className="text-muted-foreground/60">{NO_REASON}</span>
  ) : (
    // Operator-authored prose: preserve the line breaks they typed.
    <span className="whitespace-pre-wrap break-words">{reason}</span>
  );
}

function PlanTable({ rows }: { rows: readonly PlanChangeLogRowDto[] }): ReactElement {
  return (
    <table className="w-full border-collapse">
      <thead className="border-b border-border bg-muted/40">
        <tr>
          <th className={TH}>时间</th>
          <th className={TH}>部 / 课</th>
          <th className={TH}>年月</th>
          <th className={TH}>字段</th>
          <th className={TH}>变更</th>
          <th className={TH}>原因</th>
          <th className={TH}>操作者</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.length === 0 ? (
          <EmptyRow span={7} text="本财年暂无计划变更记录" />
        ) : (
          rows.map((row) => (
            <tr key={row.id} className="hover:bg-muted/30">
              <td className={`${TD} whitespace-nowrap tabular-nums text-muted-foreground`}>
                {formatTimestamp(row.changedAt)}
              </td>
              <td className={TD}>
                <span className="text-muted-foreground">{row.departmentName}</span>
                <span className="mx-1 text-muted-foreground/50">/</span>
                <span className="font-medium">{row.sectionName}</span>
              </td>
              <td className={`${TD} whitespace-nowrap tabular-nums`}>{row.monthLabel}</td>
              <td className={`${TD} whitespace-nowrap`}>{labelOf(FIELD_LABELS, row.field)}</td>
              <td className={`${TD} whitespace-nowrap tabular-nums`}>
                <span className="text-muted-foreground">{row.beforeValue}</span>
                <span className="mx-1.5 text-muted-foreground/50">→</span>
                <span className="font-medium">{row.afterValue}</span>
              </td>
              <td className={`${TD} max-w-xs`}>
                <ReasonCell reason={row.reason} />
              </td>
              <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{row.changedBy}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function MasterTable({ rows }: { rows: readonly MasterDataChangeLogDto[] }): ReactElement {
  return (
    <table className="w-full border-collapse">
      <thead className="border-b border-border bg-muted/40">
        <tr>
          <th className={TH}>时间</th>
          <th className={TH}>类别</th>
          <th className={TH}>动作</th>
          <th className={TH}>对象</th>
          <th className={TH}>快照</th>
          <th className={TH}>原因</th>
          <th className={TH}>操作者</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.length === 0 ? (
          <EmptyRow span={7} text="暂无组织 / 规则变更记录" />
        ) : (
          rows.map((row) => (
            <tr key={row.id} className="hover:bg-muted/30">
              <td className={`${TD} whitespace-nowrap tabular-nums text-muted-foreground`}>
                {formatTimestamp(row.changedAt)}
              </td>
              <td className={`${TD} whitespace-nowrap`}>{labelOf(ENTITY_LABELS, row.entity)}</td>
              <td className={`${TD} whitespace-nowrap`}>{labelOf(ACTION_LABELS, row.action)}</td>
              <td className={`${TD} max-w-[12rem] break-words font-medium`}>{row.targetKey}</td>
              <td className={TD}>
                {/* Native <details>: a collapsible raw payload with no client JS. */}
                <details className="group">
                  <summary className="cursor-pointer list-none text-xs text-muted-foreground marker:content-none hover:text-foreground">
                    <span className="tabular-nums">{summariseSnapshot(row.snapshot)}</span>
                    <span className="ml-1.5 text-plan group-open:hidden">查看快照</span>
                    <span className="ml-1.5 hidden text-plan group-open:inline">收起</span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed">
                    {prettyPrintSnapshot(row.snapshot)}
                  </pre>
                </details>
              </td>
              <td className={`${TD} max-w-xs`}>
                <ReasonCell reason={row.reason} />
              </td>
              <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{row.changedBy}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * Status cell. Anything other than SUCCESS is tinted, because the reason this tab exists
 * is that a failed import is otherwise indistinguishable from a quiet day - every other
 * page keeps rendering last week's figures as if they were current.
 */
function ImportStatusCell({ status }: { status: ImportLogDto["status"] }): ReactElement {
  const isBad = status !== "SUCCESS";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-medium ${
        isBad ? "bg-warn/15 text-warn" : "bg-muted text-muted-foreground"
      }`}
    >
      {IMPORT_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Error and warning in one column, both shown when both exist.
 *
 * A PARTIAL row can legitimately carry an errorMessage and a D-222 warningMessage at the
 * same time, and they are not the same claim - one says rows were rejected, the other says
 * the rows that landed look incomplete. Collapsing them to whichever is non-null first
 * would hide half of what went wrong.
 */
function ImportNoteCell({ row }: { row: ImportLogDto }): ReactElement {
  if (row.errorMessage === null && row.warningMessage === null) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <div className="space-y-1">
      {row.errorMessage === null ? null : (
        <p className="whitespace-pre-wrap break-words text-warn">{row.errorMessage}</p>
      )}
      {row.warningMessage === null ? null : (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {row.warningMessage}
        </p>
      )}
    </div>
  );
}

/**
 * D-229 supersede count: rows this import marked as deleted-by-HR.
 *
 * Zero renders as a dash rather than "0" on purpose. Almost every row is zero - only the
 * afternoon fetch of a day whose roster shrank is not - and a column of black zeros trains
 * the reader to stop looking at it, which is exactly when the one non-zero matters.
 *
 * A non-zero value is NOT an error, so it is not styled as one: HR deleting a row is normal
 * and the mark is what keeps the total honest. It is emphasised only because it is the one
 * import outcome that lowers a month's hours without any file having failed.
 *
 * Note that 0 does not prove nothing was removed - the sharp-drop guard forces it to 0 when
 * it refuses to supersede, and says so in 说明. The two columns have to be read together.
 */
function SupersededCell({ row }: { row: ImportLogDto }): ReactElement {
  if (row.supersededCount === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return <span className="font-medium">{row.supersededCount}</span>;
}

function ImportTable({ rows }: { rows: readonly ImportLogDto[] }): ReactElement {
  return (
    <table className="w-full border-collapse">
      <thead className="border-b border-border bg-muted/40">
        <tr>
          <th className={TH}>时间</th>
          <th className={TH}>文件名</th>
          <th className={TH}>触发方式</th>
          <th className={TH}>状态</th>
          <th className={TH}>行数</th>
          <th className={TH}>撤销</th>
          <th className={TH}>说明</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.length === 0 ? (
          <EmptyRow span={7} text="暂无数据导入记录" />
        ) : (
          rows.map((row) => (
            <tr key={row.id} className="hover:bg-muted/30">
              <td className={`${TD} whitespace-nowrap tabular-nums text-muted-foreground`}>
                {formatTimestamp(row.importedAt)}
              </td>
              <td className={`${TD} max-w-[16rem] break-all font-medium`}>{row.fileName}</td>
              <td className={`${TD} whitespace-nowrap`}>
                {IMPORT_TRIGGER_LABELS[row.triggeredBy]}
              </td>
              <td className={`${TD} whitespace-nowrap`}>
                <ImportStatusCell status={row.status} />
              </td>
              {/* Muted on FAILED: the repository forces rowCount to 0 there, and a plain
                  black 0 reads as "an empty file imported fine". */}
              <td
                className={`${TD} whitespace-nowrap tabular-nums ${
                  row.status === "FAILED" ? "text-muted-foreground/60" : ""
                }`}
              >
                {row.rowCount}
              </td>
              <td className={`${TD} whitespace-nowrap tabular-nums`}>
                <SupersededCell row={row} />
              </td>
              <td className={`${TD} max-w-md`}>
                <ImportNoteCell row={row} />
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

interface AuditPageProps {
  /** A Promise since Next 16 - see /plans and /actuals for the same shape. */
  searchParams?: Promise<{ tab?: string; page?: string }>;
}

export default async function AuditPage({ searchParams }: AuditPageProps): Promise<ReactElement> {
  // First statement, before any read: this is the only thing standing between an
  // anonymous visitor and the entire change history. The proxy matcher is a redirect
  // convenience, not a boundary.
  await requireAdminPage("/admin/audit");

  const params = (await searchParams) ?? {};
  const tab: AuditTab = parseAuditTab(params.tab);
  const requestedPage = parsePageNumber(params.page);

  const fiscalYear = await findCurrentFiscalYear();

  // All three totals are needed regardless of the active tab so the tab labels can carry
  // their counts; the row query only runs for the tab on screen.
  const [planTotal, masterTotal, importTotal] = await Promise.all([
    fiscalYear === null ? Promise.resolve(0) : countPlanChangeLogsByFiscalYear(fiscalYear.id),
    countMasterDataChangeLogs(),
    countImportLogs(),
  ]);

  // A Record rather than a ternary chain: a fourth trail would otherwise compile fine while
  // silently paging against the wrong total.
  const totals: Readonly<Record<AuditTab, number>> = {
    plan: planTotal,
    master: masterTotal,
    import: importTotal,
  };
  const total = totals[tab];
  const pageCount = pageCountOf(total);
  // Clamped against the real total rather than trusted: `?page=99` on a one-page trail
  // would otherwise render an empty table under the heading "第 99 / 1 页", which reads
  // like the records are missing rather than like the page number was wrong.
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * PAGE_SIZE;

  const planRows =
    tab === "plan" && fiscalYear !== null
      ? await findPlanChangeLogPage({ fiscalYearId: fiscalYear.id, limit: PAGE_SIZE, offset })
      : [];
  const masterRows =
    tab === "master" ? await findMasterDataChangeLogs({ limit: PAGE_SIZE, offset }) : [];
  const importRows =
    tab === "import" ? await findImportLogPage({ limit: PAGE_SIZE, offset }) : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div className="mb-5 flex items-center justify-between gap-6">
            <MainNav active="audit" />
            <span className="text-xs text-muted-foreground">
              {fiscalYear === null ? "未设置财年" : fiscalYear.name} · 管理员已登录
            </span>
          </div>
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            Audit Trail
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">变更审计</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            记录不可修改、不做删除，永久保留。计划变更按当前财年筛选；组织 / 规则变更与数据导入为全量。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <AuditTabs active={tab} totals={totals} />

        <div className="mt-4 overflow-hidden rounded-lg bg-card ring-1 ring-border">
          <div className="overflow-x-auto">
            {/* One guarded render per tab rather than a nested ternary: each table takes a
                different row type, and the three stay independently readable. */}
            {tab === "plan" ? <PlanTable rows={planRows} /> : null}
            {tab === "master" ? <MasterTable rows={masterRows} /> : null}
            {tab === "import" ? <ImportTable rows={importRows} /> : null}
          </div>
          <AuditPager tab={tab} page={page} pageCount={pageCount} total={total} />
        </div>

        {tab === "plan" && fiscalYear === null ? (
          <p className="mt-4 text-sm text-muted-foreground">
            尚未设置当前财年，无法筛选计划变更记录。请先在管理页设置财年。
          </p>
        ) : null}
      </main>
    </div>
  );
}
