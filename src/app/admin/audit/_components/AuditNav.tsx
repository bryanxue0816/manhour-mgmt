// URL-driven tab bar and pager for the audit page (D-183).
//
// Both are Server Components rendering plain <Link>s, and that is the load-bearing
// decision here rather than a stylistic one. `src/components/ui/tabs.tsx` exists and
// would look the part, but it is a base-ui client component that owns its own selected
// state: tab changes would not touch the URL, so `?page=` could not say which tab it
// belonged to, and a link to "page 3 of the organisation trail" - exactly what somebody
// investigating a change wants to paste into a message - would be unexpressible.
//
// Keeping the selection in the URL also means the whole audit page ships zero client
// JavaScript, and that the browser Back button walks the operator back through the
// pages they actually looked at.

import Link from "next/link";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/** Which trail is on screen. Serialised into `?tab=`. */
export type AuditTab = "plan" | "master" | "import";

const TAB_LABELS: Readonly<Record<AuditTab, string>> = {
  plan: "计划变更",
  master: "组织 / 规则变更",
  import: "数据导入",
};

const TABS: readonly AuditTab[] = ["plan", "master", "import"];

/**
 * Parses `?tab=`, defaulting to the plan trail.
 *
 * Anything unrecognised falls back rather than 404s: a stale bookmark or a hand-edited
 * URL should land the operator on a working page, not an error.
 *
 * Matched against TABS rather than spelled out, so adding a trail cannot leave its URL
 * unreachable while its tab renders (D-226 added the third one this way).
 */
export function parseAuditTab(raw: string | undefined): AuditTab {
  return TABS.find((tab) => tab === raw) ?? "plan";
}

/**
 * Parses `?page=` into a 1-based page number.
 *
 * Clamps to 1 instead of rejecting. `page=0`, `page=-3` and `page=abc` are all the same
 * request as far as the operator is concerned, and an audit page is the last place to
 * make somebody debug a query string.
 */
export function parsePageNumber(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/** Href for a given tab and page. Page 1 is left implicit to keep URLs short. */
function auditHref(tab: AuditTab, page: number): string {
  return page <= 1 ? `/admin/audit?tab=${tab}` : `/admin/audit?tab=${tab}&page=${page}`;
}

const TAB_BASE =
  "inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors";

export interface AuditTabsProps {
  active: AuditTab;
  /** Row totals per tab, shown in the label so the counts are visible unopened. */
  totals: Readonly<Record<AuditTab, number>>;
}

export function AuditTabs({ active, totals }: AuditTabsProps): ReactElement {
  return (
    // A nav rather than a role="tablist": these are links to distinct URLs, and
    // announcing them as tabs would promise arrow-key behaviour that plain links do
    // not have.
    <nav aria-label="留痕类别" className="border-b border-border">
      <ul className="-mb-px flex items-center gap-1">
        {TABS.map((tab) => {
          const isActive = tab === active;
          return (
            <li key={tab}>
              <Link
                // Always page 1: a tab switch is a new question, and carrying page 7
                // across would land the operator on an empty page whenever the other
                // trail is shorter.
                href={auditHref(tab, 1)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  TAB_BASE,
                  "border-b-2",
                  isActive
                    ? "border-plan font-medium text-plan"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {TAB_LABELS[tab]}
                <span className="ml-2 tabular-nums text-xs text-muted-foreground">
                  {totals[tab]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export interface AuditPagerProps {
  tab: AuditTab;
  /** 1-based, already clamped by parsePageNumber(). */
  page: number;
  pageCount: number;
  total: number;
}

export function AuditPager({ tab, page, pageCount, total }: AuditPagerProps): ReactElement {
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
      <span className="text-xs text-muted-foreground tabular-nums">
        共 {total} 条 · 第 {page} / {pageCount} 页
      </span>
      <div className="flex items-center gap-2">
        {/* A disabled <span> rather than a dead link: a link that goes nowhere is
            reachable by keyboard and announced as a link, which is a lie. */}
        {hasPrevious ? (
          <Link href={auditHref(tab, page - 1)} className={cn(TAB_BASE, "ring-1 ring-border hover:bg-muted")}>
            上一页
          </Link>
        ) : (
          <span className={cn(TAB_BASE, "text-muted-foreground/50")} aria-hidden="true">
            上一页
          </span>
        )}
        {hasNext ? (
          <Link href={auditHref(tab, page + 1)} className={cn(TAB_BASE, "ring-1 ring-border hover:bg-muted")}>
            下一页
          </Link>
        ) : (
          <span className={cn(TAB_BASE, "text-muted-foreground/50")} aria-hidden="true">
            下一页
          </span>
        )}
      </div>
    </div>
  );
}
