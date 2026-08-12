/**
 * /plans/import - bulk import of the plan workbook (D-142).
 *
 * A thin Server Component: it supplies the fiscal-year list and defers everything else
 * to the client form, because the import is inherently interactive (pick, preview,
 * confirm) and the preview must be shown before anything is written.
 *
 * `force-dynamic` for the same reason as /plans: without it Next prerenders the route
 * at build time and opens a database connection on a machine that has no dev.db.
 */
import type { ReactElement } from "react";

import { PlanImportForm } from "./_components/PlanImportForm";
import { MainNav } from "@/components/layout/MainNav";
import { findAllFiscalYears, findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "计划工时批量导入 | 工时管理系统",
  description: "上传 Excel 批量导入某财年各课 12 个月的计划工时与挑战工时",
};

/** Shown when no fiscal year exists - seeding has not run, so there is nothing to import into. */
function EmptyState(): ReactElement {
  return (
    <div className="rounded-lg bg-card px-6 py-10 text-center ring-1 ring-border">
      <p className="text-sm text-muted-foreground">
        尚未创建任何财年。请先执行数据初始化(prisma db seed)后再导入计划工时。
      </p>
    </div>
  );
}

export default async function PlanImportPage(): Promise<ReactElement> {
  const [years, current] = await Promise.all([
    findAllFiscalYears(),
    findCurrentFiscalYear(),
  ]);

  const defaultFiscalYearId = current?.id ?? years[0]?.id ?? "";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-full space-y-4 px-6 py-6">
          <div className="flex items-center justify-between gap-6">
            <MainNav active="plans" />
            <span className="text-xs text-muted-foreground">批量导入 · 内网免登录</span>
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              计划工时批量导入
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              上传《FY__工时计划.xlsx》,系统先完整校验并预览,确认后再一次性写入。
              校验不通过时不会写入任何数据。
            </p>
          </div>
          <a
            href="/plans"
            className="inline-flex text-sm font-medium text-plan underline-offset-4 hover:underline"
          >
            ← 返回计划工时录入
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-full space-y-6 px-6 py-8">
        {years.length === 0 || defaultFiscalYearId === "" ? (
          <EmptyState />
        ) : (
          <PlanImportForm
            fiscalYears={years.map((year) => ({
              id: year.id,
              name: year.name,
              isCurrent: year.isCurrent,
            }))}
            defaultFiscalYearId={defaultFiscalYearId}
          />
        )}
      </main>
    </div>
  );
}
