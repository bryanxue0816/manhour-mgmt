'use client';

import { useCallback, useState } from 'react';
import type { DrillState } from '@/types/manhour';

export interface UseDrillReturn {
  state: DrillState;
  /**
   * Navigate to a drill state. Takes the whole state object rather than
   * positional (level, deptIdx?, secIdx?) arguments, so the discriminated union
   * makes illegal targets (level 1 with no dept) a compile error at the call
   * site instead of a runtime crash inside selectNode.
   */
  go: (next: DrillState) => void;
  back: () => void;
}

/**
 * Drill state machine for the man-hour dashboard.
 *
 * Single-page (Phase 1) navigation across three org levels:
 *   0 = whole company (全社)
 *   1 = department (部)
 *   2 = section (课)
 *
 * The state is intentionally plain (no router involvement) so the dashboard
 * stays deterministic and testable in isolation. All transitions produce a
 * new state object; the previous state is never mutated.
 */
export function useDrill(): UseDrillReturn {
  const [state, setState] = useState<DrillState>({ level: 0 });

  const go = useCallback((next: DrillState) => {
    setState(next);
  }, []);

  /**
   * Step up exactly one level:
   *   section (2) -> department (1), preserving deptIdx
   *   department (1) -> company (0)
   *   company (0) -> no-op (cannot drill above the root)
   *
   * Implemented with a functional updater so the handler identity stays
   * stable (empty deps) without capturing a stale `state` closure.
   */
  const back = useCallback(() => {
    setState((prev) => {
      if (prev.level === 2) {
        return { level: 1, deptIdx: prev.deptIdx };
      }
      if (prev.level === 1) {
        return { level: 0 };
      }
      return prev;
    });
  }, []);

  return { state, go, back };
}
