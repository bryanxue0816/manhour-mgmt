import type { ReactNode } from "react";

/**
 * AppShell - three-region layout for the man-hour dashboard.
 * Top: title bar + breadcrumb. Left: org tree nav. Main: KPI + charts + detail.
 * Matches v18 UI structure (DESIGN.md "v18 看板设计").
 */
export function AppShell({
  breadcrumb,
  sidebar,
  nav,
  fiscalYearLabel,
  children,
}: {
  breadcrumb: ReactNode;
  sidebar: ReactNode;
  /**
   * Cross-screen navigation. Passed in rather than imported so it can stay a
   * Server Component even though AppShell itself renders inside a client tree.
   */
  nav: ReactNode;
  /**
   * The current fiscal year, resolved from the database by the page.
   *
   * Previously hardcoded as "FY2026". A label that cannot be wrong is worth the
   * prop: once a second year exists, a frozen string here would quietly
   * contradict the data the rest of the page is showing.
   */
  fiscalYearLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b bg-card px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">工时管控台</h1>
            {nav}
          </div>
          <span className="text-xs text-muted-foreground">
            {fiscalYearLabel} · 内网免登录
          </span>
        </div>
        {breadcrumb}
      </header>
      <div className="flex flex-1">
        <aside className="w-64 shrink-0 border-r bg-card p-3">
          {sidebar}
        </aside>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
