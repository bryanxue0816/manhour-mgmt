'use client';

/**
 * Breadcrumb - drill path indicator (全社 / 部 / 课).
 *
 * Renders the current drill stack as clickable segments so the user can jump
 * back to any ancestor level. The current (deepest) segment is non-clickable
 * and highlighted with a red underline. Each segment carries a colored level
 * tag badge (L0 blue / L1 green / L2 orange) aligned with the v18 level-tag
 * convention.
 *
 * Phase 1 wiring: the parent page owns the DrillState and passes both the
 * derived segments and an onNavigate handler down.
 */
import { ChevronRight } from "lucide-react";

import type { BreadcrumbSegment, DrillLevel, DrillState } from "@/types/manhour";
import { cn } from "@/lib/utils";

export interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  /**
   * Navigate to an ancestor drill state. Takes the whole state object so an
   * illegal target (level 1 without a dept index) cannot be constructed.
   */
  onNavigate: (next: DrillState) => void;
}

/** Badge background per drill level (matches v18 level-tag colors). */
const LEVEL_BADGE_CLASS: Record<DrillLevel, string> = {
  0: "bg-plan",
  1: "bg-challenge",
  2: "bg-warn",
};

/** Short tag label per drill level. */
const LEVEL_BADGE_LABEL: Record<DrillLevel, string> = {
  0: "l0",
  1: "l1",
  2: "l2",
};

export function Breadcrumb({ segments, onNavigate }: BreadcrumbProps): JSX.Element {
  return (
    <nav
      className="mt-1 text-sm text-muted-foreground"
      aria-label="Breadcrumb"
    >
      <ol className="flex flex-wrap items-center gap-1">
        {/* Prefix label (aligned with v18). Kept as the first <li> so the
            nav > ol > li structure is preserved and the flex flow stays
            simple. */}
        <li className="flex items-center">
          <span className="mr-1">当前视图：</span>
        </li>
        {segments.map((seg, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight
                className="size-3.5 text-muted-foreground/50"
                aria-hidden="true"
              />
            )}
            {seg.isCurrent ? (
              // Current segment: bold, red underline, non-clickable.
              <span className="border-b-2 border-actual font-semibold text-foreground">
                {seg.label}
              </span>
            ) : (
              // Ancestor segment: clickable, returns to that drill level.
              <button
                type="button"
                onClick={() => onNavigate(seg.target)}
                className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
              >
                {seg.label}
              </button>
            )}
            {/* Level tag badge (L0/L1/L2). */}
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs text-white",
                LEVEL_BADGE_CLASS[seg.level],
              )}
            >
              {LEVEL_BADGE_LABEL[seg.level]}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
