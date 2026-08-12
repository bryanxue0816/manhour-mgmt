/**
 * Attendance upload route (D-170).
 *
 * The browser is the ONLY routine entry point for actuals since D-170. scripts/fetch-attendance.ts
 * still exists as an operator-driven bulk backfill, but it reads from a share the app cannot
 * reach, so nothing on this screen depends on it.
 *
 * A shell, not a page: everything interactive lives in AttendanceImportForm because the two
 * Server Actions need the raw File bytes twice (preview, then commit) and only a client
 * component can hold them between the two calls.
 */
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { AttendanceImportForm } from "./_components/AttendanceImportForm";
import { MainNav } from "@/components/layout/MainNav";

/**
 * Without this Next prerenders the route at build time. This shell reads nothing from the
 * database, but the actions it posts to do, and keeping the whole route dynamic avoids the
 * class of surprise where a later addition to this file opens a connection on a build
 * machine that has no dev.db.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "导入考勤数据 | 工时管理",
  description: "上传 HR 日考勤报表，逐文件预览后写入实绩工时。",
};

export default function AttendanceImportPage(): ReactElement {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-full space-y-4 px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <MainNav active="actuals" />
            <span className="text-xs text-muted-foreground">考勤导入 · 内网免登录</span>
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              导入考勤数据
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              上传 HR 导出的日考勤报表（.xls）。先检查预览逐文件的判定结果，确认后再写入。
              导入会重算受影响月份的实绩工时。
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
        <AttendanceImportForm />
      </main>
    </div>
  );
}
