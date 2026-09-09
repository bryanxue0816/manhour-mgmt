// Boundary lock for the KPI verdict face (😊/😞): when does a "remaining hours"
// figure count as on track?
//
// Hours are lower-is-better: remain = target - actual. The 2026-08-03 HTML
// prototype's `face()` predicate used `v >= 0`, i.e. landing squarely on the
// target (exactly 0) is an achievement and shows 😊. The React cards instead
// inlined `remain > 0`, which flipped a dead-on-target 0 to the red 😞/超支
// verdict. `isRemainOnTrack` restores the prototype boundary as one shared
// predicate for all three remaining-hours cards.
//
// The zero case below is the point of this file: it is the exact boundary the
// user signed off on (「踩线即达成」) and the branch the old `> 0` got wrong.
//
// Pure scalar function: no Prisma, no DATABASE_URL, no React.

import { describe, expect, it } from "vitest";

import { isRemainOnTrack } from "@/lib/calc";

describe("isRemainOnTrack", () => {
  it("is on track when hours remain below target", () => {
    // 年计剩余 33H in the prototype screenshot.
    expect(isRemainOnTrack(33)).toBe(true);
    expect(isRemainOnTrack(109)).toBe(true);
    expect(isRemainOnTrack(0.5)).toBe(true);
  });

  it("counts exactly zero as achieved - the >= 0 boundary (踩线即达成)", () => {
    expect(isRemainOnTrack(0)).toBe(true);
    // -0 and 0 are the same boundary for comparison purposes.
    expect(isRemainOnTrack(-0)).toBe(true);
  });

  it("is off track when actual exceeded target", () => {
    // 当月挑战剩余 -82H in the prototype screenshot.
    expect(isRemainOnTrack(-82)).toBe(false);
    expect(isRemainOnTrack(-0.5)).toBe(false);
  });
});
