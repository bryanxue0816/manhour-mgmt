// Top-level navigation shared by the four screens.
//
// A Server Component on purpose. The obvious instinct is to mark the active link
// with usePathname(), which would force "use client" and ship this to the browser
// on every page - but each page already knows which one it is at render time, so
// the caller passes `active` and nothing needs to be interactive. The links are
// plain <Link>s; there is no state here to keep. Being a Server Component is also
// what lets it read the session directly, below.
//
// Kept separate from AppShell because AppShell lives inside DashboardClient (a
// client component) while /actuals, /plans and /admin render their own headers. A
// nav that only existed in AppShell would be unreachable from the other three.
//
// The permission filtering here is PRESENTATION, not protection. Hiding 管理 stops
// nobody: the href was never secret, and a Server Action executes no matter which
// route it is POSTed to (measured 2026-08-17 - see the header of src/lib/auth.ts).
// The point is that a shop-floor user opening the dashboard is not shown three links
// that would only bounce them to a login form.
import Link from "next/link";
import type { ReactElement } from "react";

import { logout } from "@/app/login/actions";
import { isAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** Identifies which screen is rendering the nav, so it can mark itself. */
export type NavKey = "dashboard" | "actuals" | "plans" | "admin" | "audit";

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
}

/**
 * The five screens, in the order the work actually flows: look at the numbers,
 * check what the attendance import actually produced, enter next month's plan,
 * check the master data behind all of them, and read back who changed what.
 *
 * 实绩 sits next to 看板 rather than next to 计划录入 because both are read-only
 * views of the same figures - the dashboard aggregates them, /actuals shows the
 * per-section rows and the import health behind them.
 *
 * 审计 sits last because it answers questions about the other four rather than
 * being a step in the flow.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", href: "/", label: "看板" },
  { key: "actuals", href: "/actuals", label: "实绩" },
  { key: "plans", href: "/plans", label: "计划录入" },
  { key: "admin", href: "/admin", label: "管理" },
  { key: "audit", href: "/admin/audit", label: "审计" },
];

export interface MainNavProps {
  /** The screen rendering this nav. Its link is marked and not clickable-looking. */
  active: NavKey;
}

/** Shared by the nav links and the login/logout control so they line up. */
const ITEM_BASE =
  "inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors";

const ITEM_IDLE = "text-muted-foreground hover:bg-muted hover:text-foreground";

export async function MainNav({ active }: MainNavProps): Promise<ReactElement> {
  const admin = await isAdmin();

  // 看板 is the only public screen, so it is the only one an anonymous visitor is
  // offered. See the file header: this is a courtesy, not a lock.
  const items = admin ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.key === "dashboard");

  return (
    <nav aria-label="主导航">
      <ul className="flex items-center gap-1">
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                // aria-current is what a screen reader announces as "current page";
                // the ring is only the visual half of the same statement.
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  ITEM_BASE,
                  isActive
                    ? "bg-plan/10 font-medium text-plan ring-1 ring-plan/25"
                    : ITEM_IDLE,
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
        <li className="ml-2 border-l border-border pl-2">
          {admin ? (
            // A form rather than a link: logging out changes server state, and a GET
            // that mutates would let a prefetch or a crawler sign the operator out.
            <form action={logout}>
              <button type="submit" className={cn(ITEM_BASE, ITEM_IDLE)}>
                退出
              </button>
            </form>
          ) : (
            <Link href="/login" className={cn(ITEM_BASE, ITEM_IDLE)}>
              管理员登录
            </Link>
          )}
        </li>
      </ul>
    </nav>
  );
}
