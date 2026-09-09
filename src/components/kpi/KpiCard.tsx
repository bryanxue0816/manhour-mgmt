/**
 * KPI four-card row for the man-hour dashboard (DESIGN.md v18).
 *
 * Renders four shadcn Cards in a responsive grid:
 *   1. actual     - current-month actual hours vs budget
 *   2. planRemain - plan remaining for the month (😊/😞 status pill)
 *   3. chalRemain - challenge remaining for the month (😊/😞 status pill)
 *   4. cumRemain  - cumulative remaining vs plan (😊/😞 status pill)
 *
 * Each card is a headline figure plus one caption or pill line. The cards carry
 * no progress bars: two of the four were pinned at 100% and encoded nothing, and
 * the other two duplicated a percentage the caption already states in words.
 * The three remaining-hours cards share one verdict resolved by kpiVerdict()
 * (src/lib/kpi-verdict.ts), which binds the shared on-track predicate
 * (remainder >= 0; exactly 0 is landing on target) to one verbatim label pair
 * 达成/不达成. Since 2026-09-09 all three pills draw wording from that single
 * source - previously the cards said 达成/超支 and 优于挑战/未达挑战, and a third
 * carried a numeric arrow/delta sentence; the wordings had drifted apart - so
 * the labels cannot diverge again. Each verdict card
 * carries exactly one face: a large decorative emoji at the right edge as the
 * at-a-glance cue. The pill beneath the figure is colored wording only, no
 * emoji (user decision 2026-09-09: one face per card), sized text-2xl so the
 * verdict reads at a glance (same decision: make the badge prominent). The
 * emoji is aria-hidden because the pill text already carries the verdict for
 * screen readers. Status pills keep the brand CSS-variable utilities
 * (bg-challenge / bg-actual) registered in globals.css; no hardcoded hex
 * values.
 */
import * as React from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatHoursBare, formatSignedHoursBare } from "@/lib/format";
import { kpiVerdict } from "@/lib/kpi-verdict";
import { cn } from "@/lib/utils";
import type { KpiData } from "@/types/manhour";

/** Which KPI card to render. */
export type KpiCardVariant = "actual" | "planRemain" | "chalRemain" | "cumRemain";

export interface KpiCardProps {
  variant: KpiCardVariant;
  data: KpiData;
}

export interface KpiRowProps {
  data: KpiData;
}

/** Compact text-only status pill: green wording when `ok`, red otherwise.
 *  Uses brand colors with 20% opacity backgrounds via Tailwind 4 opacity
 *  modifiers. The verdict face lives only in the large decorative emoji of
 *  VerdictCardBody - the pill itself deliberately carries no emoji (user
 *  decision 2026-09-09: one face per card). Wording always comes from
 *  kpiVerdict() (single label source, same decision 2026-09-09), so the three
 *  cards cannot drift apart again. Sized text-2xl (24px, 2x the original
 *  text-xs) per user request for an at-a-glance verdict; leading-none and the
 *  larger padding keep the capsule tight at the bigger size. */
function StatusPill({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-4 py-1 text-2xl font-medium leading-none",
        ok ? "bg-challenge/20 text-challenge" : "bg-actual/20 text-actual",
      )}
    >
      {label}
    </span>
  );
}

/**
 * Body layout shared by the three verdict cards: the figure and its pill on
 * the left, one verdict face on the right as the at-a-glance status cue
 * (user-requested 2026-09-09). Sized text-5xl (48px, 1.6x the 30px figure)
 * after a design review: at the original text-7xl (72px, 2.4x the figure) the
 * decorative face out-weighed the KPI number itself, which clashes with the
 * calm data-dense App UI register of the rest of the dashboard. The face is
 * purely decorative - the pill text below the figure is the accessible
 * verdict - hence aria-hidden. The actual-hours card has no verdict and does
 * not use this.
 */
function VerdictCardBody({
  ok,
  children,
}: {
  ok: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
      <span aria-hidden="true" className="select-none text-5xl leading-none">
        {ok ? "😊" : "😞"}
      </span>
    </div>
  );
}

/**
 * Title text for each variant.
 *
 * The three month-scoped cards name the month they report on. The anchored month
 * is the newest one with data, which is routinely NOT the calendar month - in
 * August 2026 the newest import is 26/07 - and a card reading just 「当月」 invites
 * reading a July figure as an August one (D-165). 「最新月」 states the rule and the
 * parenthesised label states the answer.
 */
function variantTitle(variant: KpiCardVariant, data: KpiData): string {
  switch (variant) {
    case "actual":
      return `最新月实绩（${data.monthLabel} · ${data.levelName}）`;
    case "planRemain":
      return `最新月（${data.monthLabel}）年计剩余`;
    case "chalRemain":
      return `最新月（${data.monthLabel}）挑战剩余`;
    case "cumRemain":
      return "累计剩余";
  }
}

/** Inner content for one KPI card; branches on variant. */
function KpiCardContent({
  variant,
  data,
}: KpiCardProps): React.ReactElement {
  switch (variant) {
    case "actual": {
      return (
        <>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatHoursBare(data.monthActual)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <p className="text-xs text-muted-foreground">
            预算已用 {data.usedPct}%（计划 {formatHoursBare(data.monthPlan)}）
          </p>
        </>
      );
    }
    case "planRemain": {
      const verdict = kpiVerdict(data.monthPlanRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthPlanRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
    case "chalRemain": {
      const verdict = kpiVerdict(data.monthChalRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthChalRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
    case "cumRemain": {
      const verdict = kpiVerdict(data.cumRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.cumRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
  }
}

/** A single KPI card. */
export function KpiCard({ variant, data }: KpiCardProps): React.ReactElement {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{variantTitle(variant, data)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <KpiCardContent variant={variant} data={data} />
      </CardContent>
    </Card>
  );
}

/** Four KPI cards laid out in a row. Two columns on small screens, four on
 *  large screens so the cards stay readable on narrow viewports. */
export function KpiRow({ data }: KpiRowProps): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiCard variant="actual" data={data} />
      <KpiCard variant="planRemain" data={data} />
      <KpiCard variant="chalRemain" data={data} />
      <KpiCard variant="cumRemain" data={data} />
    </div>
  );
}
