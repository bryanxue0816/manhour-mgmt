/**
 * 404 page.
 *
 * A Server Component - nothing here is interactive, so there is no reason to ship
 * it to the browser.
 *
 * The copy names the two ways a user actually lands here, because both are real in
 * this app and they call for different actions: a mistyped path, or a bookmarked
 * URL from a screen that no longer exists. What it must NOT do is read like an
 * empty data state - "没有找到数据" would send an operator hunting for a missing
 * import when the truth is simply that this address has no page.
 *
 * Deliberately not `<MainNav>`: its `active` prop is one of the four screens, and
 * this page is none of them. Passing an arbitrary key would mark an unrelated tab as
 * the current page and make aria-current announce something false.
 */

import Link from "next/link";
import type { ReactElement } from "react";

import { buttonVariants } from "@/components/ui/button";

export const metadata = {
  title: "页面不存在 | 工时管理系统",
};

/** The four real screens, with what each one is for. */
const DESTINATIONS: readonly { href: string; label: string; hint: string }[] = [
  { href: "/", label: "看板", hint: "计划 / 挑战 / 实绩 的聚合视图与下钻" },
  { href: "/actuals", label: "实绩", hint: "各课 12 个月实绩明细与考勤导入健康度" },
  { href: "/plans", label: "计划录入", hint: "按课录入或导入月度计划与挑战工时" },
  { href: "/admin", label: "管理", hint: "组织结构、财年与系统配置的只读视图" },
];

export default function NotFoundPage(): ReactElement {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            404
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">页面不存在</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            该地址没有对应的页面。可能是网址输入有误，或来自一个已经调整过的旧链接。
            这不是数据缺失——系统中的工时数据不受影响。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          可用页面
        </h2>
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {DESTINATIONS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-baseline gap-4 px-4 py-3 transition-colors hover:bg-muted"
              >
                <span className="w-20 shrink-0 text-sm font-medium">{item.label}</span>
                <span className="text-sm text-muted-foreground">{item.hint}</span>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-6">
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            返回看板
          </Link>
        </div>
      </main>
    </div>
  );
}
