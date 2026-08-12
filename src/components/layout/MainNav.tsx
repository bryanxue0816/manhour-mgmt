// Top-level navigation shared by the four screens.
//
// A Server Component on purpose. The obvious instinct is to mark the active link
// with usePathname(), which would force "use client" and ship this to the browser
// on every page - but each page already knows which one it is at render time, so
// the caller passes `active` and nothing needs to be interactive. The links are
// plain <Link>s; there is no state here to keep.
//
// Kept separate from AppShell because AppShell lives inside DashboardClient (a
// client component) while /actuals, /plans and /admin render their own headers. A
// nav that only existed in AppShell would be unreachable from the other three.
import Link from "next/link";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/** Identifies which screen is rendering the nav, so it can mark itself. */
export type NavKey = "dashboard" | "actuals" | "plans" | "admin";

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
}

/**
 * The four screens, in the order the work actually flows: look at the numbers,
 * check what the attendance import actually produced, enter next month's plan,
 * check the master data behind all of them.
 *
 * 实绩 sits next to 看板 rather than next to 计划录入 because both are read-only
 * views of the same figures - the dashboard aggregates them, /actuals shows the
 * per-section rows and the import health behind them.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", href: "/", label: "看板" },
  { key: "actuals", href: "/actuals", label: "实绩" },
  { key: "plans", href: "/plans", label: "计划录入" },
  { key: "admin", href: "/admin", label: "管理" },
];

export interface MainNavProps {
  /** The screen rendering this nav. Its link is marked and not clickable-looking. */
  active: NavKey;
}

export function MainNav({ active }: MainNavProps): ReactElement {
  return (
    <nav aria-label="主导航">
      <ul className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                // aria-current is what a screen reader announces as "current page";
                // the ring is only the visual half of the same statement.
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-plan/10 font-medium text-plan ring-1 ring-plan/25"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
