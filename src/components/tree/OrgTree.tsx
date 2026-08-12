'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DrillState, OrgRoot } from '@/types/manhour';
import { drillDeptIdx } from '@/types/manhour';
import { cn } from '@/lib/utils';

export interface OrgTreeProps {
  org: OrgRoot;
  drillState: DrillState;
  /**
   * Drill to a new state. Takes the whole state object so an illegal target
   * (level 1 without a dept index) is a compile error at the call site.
   */
  onDrill: (next: DrillState) => void;
}

/**
 * OrgTree - left-sidebar org navigation (全社 -> 部 -> 课).
 *
 * ul>li tree aligned with the v18 org-tree interaction:
 * - Company row is always visible; clicking drills to level 0.
 * - Department rows show a caret to expand/collapse sections. Clicking the
 *   caret only toggles expand; clicking the dept name drills to level 1 and
 *   also expands that dept.
 * - Section rows appear under an expanded dept; clicking drills to level 2.
 * - Drilling into a dept auto-expands it, including drills arriving as a new
 *   drillState prop from the chart or overview table.
 *
 * Expand state is a local Set<number> of dept indices; all updates produce a
 * new Set (immutable). Active-row highlight is unified across all levels.
 */
export function OrgTree({ org, drillState, onDrill }: OrgTreeProps) {
  // Expanded dept indices. Immutable Set updates only (never mutate prev).
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Which drill target has already been auto-expanded. Without this the
  // adjustment below would re-expand a dept the user had deliberately
  // collapsed, on every single render.
  const [autoExpandedFor, setAutoExpandedFor] = useState<number | null>(null);

  // Auto-expand a dept whenever the user drills into it - including drills that
  // originate outside this component (chart or overview-table clicks arrive as a
  // new drillState prop).
  //
  // Adjusted during render rather than in an effect: an effect would run after
  // the browser had already painted the collapsed tree, so a drill from the
  // overview table expanded one frame late. React re-runs the render
  // immediately on a state update made here, before painting, so the expand is
  // never visible as a separate step. It is also why the react-hooks
  // set-state-in-effect rule flags the effect form.
  const activeDeptIdx = drillDeptIdx(drillState);
  if (activeDeptIdx !== null && activeDeptIdx !== autoExpandedFor) {
    setAutoExpandedFor(activeDeptIdx);
    setExpanded((prev) => {
      if (prev.has(activeDeptIdx)) return prev;
      const next = new Set(prev);
      next.add(activeDeptIdx);
      return next;
    });
  }

  /** Toggle a dept's expand/collapse without triggering a drill. */
  const toggleExpand = (di: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(di)) next.delete(di);
      else next.add(di);
      return next;
    });
  };

  /**
   * Expand a dept (idempotent). Used by the dept-name button, which must expand
   * even when that dept is already the drill target - the auto-expand above
   * fires once per target, so a dept the user collapsed after drilling into it
   * would otherwise stay collapsed when its name is clicked again.
   */
  const expandDept = (di: number) => {
    setExpanded((prev) => {
      if (prev.has(di)) return prev;
      const next = new Set(prev);
      next.add(di);
      return next;
    });
  };

  // Unified row styles: active vs idle.
  const activeRow = 'border-l-2 border-primary bg-primary/10 font-medium';
  const idleRow = 'hover:bg-muted/50';

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">组织结构</p>
      <ul className="space-y-0.5 text-sm">
        {/* Company row (always visible) */}
        <li>
          <button
            type="button"
            onClick={() => onDrill({ level: 0 })}
            className={cn(
              'flex w-full items-center rounded-md px-2 py-1.5 text-left',
              drillState.level === 0 ? activeRow : idleRow,
            )}
          >
            {org.name}
          </button>
        </li>

        {/* Department rows */}
        {org.depts.map((dept, di) => {
          const isExpanded = expanded.has(di);
          const isActiveDept =
            drillState.level === 1 && drillState.deptIdx === di;
          const hasSections = dept.sections.length > 0;

          return (
            <li key={di}>
              <div
                className={cn(
                  'flex items-center rounded-md',
                  isActiveDept ? activeRow : idleRow,
                )}
              >
                {hasSections && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(di)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center"
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    expandDept(di);
                    onDrill({ level: 1, deptIdx: di });
                  }}
                  className={cn(
                    'flex-1 py-1 pr-2 text-left',
                    !hasSections && 'pl-2',
                  )}
                >
                  {dept.name}
                </button>
              </div>

              {/* Section rows (only visible when the dept is expanded) */}
              {isExpanded && hasSections && (
                <ul className="ml-4 mt-0.5 space-y-0.5">
                  {dept.sections.map((sec, si) => {
                    const isActiveSec =
                      drillState.level === 2 &&
                      drillState.deptIdx === di &&
                      drillState.secIdx === si;
                    return (
                      <li key={si}>
                        <button
                          type="button"
                          onClick={() => onDrill({ level: 2, deptIdx: di, secIdx: si })}
                          className={cn(
                            'flex w-full items-center rounded-md px-2 py-1 text-left',
                            isActiveSec ? activeRow : idleRow,
                          )}
                        >
                          {sec.name}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
