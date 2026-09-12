// Admin home badge linking to the attendance staleness alert sub-page.
// Pure presentation (server component, zero client JS): the view model -
// including the four verbatim Chinese labels - is built and unit-tested in
// ../alerts/alerts-summary.ts.

import Link from "next/link";
import type { ReactElement } from "react";

import type { AlertBadgeView } from "../alerts/alerts-summary";

// Literal class strings on purpose: Tailwind scans source text and would not
// see classes assembled by string interpolation.
const TONE_CLASS: Record<AlertBadgeView["tone"], string> = {
  ok: "text-plan",
  warn: "text-warn",
  danger: "text-challenge",
};

export function AlertStatusBadge({ view }: { view: AlertBadgeView }): ReactElement {
  return (
    <Link
      href={view.href}
      className={`mt-3 inline-flex rounded-md bg-muted/60 px-3 py-2 text-xs ring-1 ring-border ${TONE_CLASS[view.tone]}`}
    >
      {view.label}
    </Link>
  );
}
