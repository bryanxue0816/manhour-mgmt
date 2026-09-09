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
 * The three remaining-hours cards share one threshold (isRemainOnTrack):
 * remainder >= 0 renders a green 😊 verdict (exactly 0 is landing on target),
 * < 0 renders a red 😞 verdict. Each verdict card carries exactly one face:
 * a large decorative emoji at the right edge as the at-a-glance cue. The pill
 * beneath the figure is colored wording only, no emoji (user decision
 * 2026-09-09: one face per card). The emoji is aria-hidden because the pill
 * text already carries the verdict for screen readers. Status pills keep the
 * brand CSS-variable utilities (bg-challenge / bg-actual) registered in
 * globals.css; no hardcoded hex values.
 */
import * as React from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isRemainOnTrack } from "@/lib/calc";
import { formatHoursBare, formatSignedHoursBare } from "@/lib/format";
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
 *  decision 2026-09-09: one face per card). `ngLabel` defaults to `okLabel`
 *  for cards whose text only varies by the leading ▲/▼ arrow, which is
 *  already derived from the same value. */
function StatusPill({
  ok,
  okLabel,
  ngLabel = okLabel,
}: {
  ok: boolean;
  okLabel: string;
  ngLabel?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-challenge/20 text-challenge" : "bg-actual/20 text-actual",
      )}
    >
      {ok ? okLabel : ngLabel}
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
      const ok = isRemainOnTrack(data.monthPlanRemain);
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthPlanRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={ok} okLabel="达成" ngLabel="超支" />
        </VerdictCardBody>
      );
    }
    case "chalRemain": {
      const ok = isRemainOnTrack(data.monthChalRemain);
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthChalRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={ok} okLabel="优于挑战" ngLabel="未达挑战" />
        </VerdictCardBody>
      );
    }
    case "cumRemain": {
      const ok = isRemainOnTrack(data.cumRemain);
      // No arrow at exactly 0: there is no direction to point at.
      const arrow =
        data.cumRemain > 0 ? "▲ " : data.cumRemain < 0 ? "▼ " : "";
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.cumRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill
            ok={ok}
            okLabel={`${arrow}距计划 ${formatSignedHoursBare(data.cumRemain)} H`}
          />
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
