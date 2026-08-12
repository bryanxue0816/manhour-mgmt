/**
 * Deterministic mock organization data for the v0.1 man-hour dashboard.
 *
 * Fixed-seed generation: this module always yields identical numbers on
 * every refresh (no Math.random). Seasonal factors shape the plan curve;
 * a mulberry32 PRNG produces stable pseudo-random actuals for non-current
 * months; the current month uses a hand-picked ratio vector so the KPI
 * three-tier coloring (green / yellow / red) is intentional and stable.
 *
 * Org structure: 7 departments, 24 sections (matches v18 design spec).
 */

import { CUR_MONTH_IDX } from '@/types/manhour';
import type { Dept, MonthlyHours, OrgRoot, Section } from '@/types/manhour';

/** Seasonal plan factors (12 months; index 0 = April). */
const SEASONAL_FACTORS: readonly number[] = [
  1.0, 0.91, 1.0, 1.05, 1.0, 1.03,
  0.86, 1.0, 1.10, 1.0, 0.58, 1.17,
];

/**
 * Hand-tuned actual/plan ratios for the current month (CUR_MONTH_IDX),
 * indexed by section global index (0..23). Deliberately spreads sections
 * across tiers: 7 green (<90%) / 10 yellow (90-100%) / 7 red (>100%).
 * Grouped by department for readability.
 */
const CUR_MONTH_ACTUAL_RATIOS: readonly number[] = [
  // Dept 0 - 经营企画部 (2 sections)
  0.85, 0.83,
  // Dept 1 - 安全人力资源部 (4 sections)
  0.88, 0.95, 0.97, 0.93,
  // Dept 2 - 生管调达部 (4 sections)
  1.05, 1.03, 0.98, 1.04,
  // Dept 3 - 品质保证部 (4 sections)
  0.94, 0.87, 1.02, 0.91,
  // Dept 4 - 生产技术部 (3 sections)
  0.86, 0.91, 0.88,
  // Dept 5 - 制造支援部 (3 sections)
  1.04, 1.06, 0.97,
  // Dept 6 - 制造部 (4 sections)
  0.96, 0.84, 1.05, 0.93,
];

/** Challenge target as a fraction of plan (more aggressive target). */
const CHALLENGE_RATIO = 0.92;

/** Inclusive lower bound of the random actual/plan ratio for past months. */
const ACTUAL_RATIO_MIN = 0.93;
/** Exclusive upper bound of the random actual/plan ratio for past months. */
const ACTUAL_RATIO_MAX = 1.01;

/** Number of months in a fiscal year. */
const MONTH_COUNT = 12;

/**
 * Deterministic PRNG (mulberry32). Given the same seed, always produces the
 * same sequence. Used instead of Math.random so refreshes are stable.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the 12-month series for one section deterministically.
 *
 * @param base               Section base hours (shapes the plan curve).
 * @param sectionGlobalIndex 0-based index of the section across the whole
 *                           org (0..23), used to seed the PRNG and to look
 *                           up the current-month ratio.
 */
function buildSectionMonths(
  base: number,
  sectionGlobalIndex: number,
): MonthlyHours[] {
  const months: MonthlyHours[] = [];
  for (let i = 0; i < MONTH_COUNT; i++) {
    const plan = Math.round(base * SEASONAL_FACTORS[i]);
    const challenge = Math.round(plan * CHALLENGE_RATIO);

    let ratio: number;
    if (i === CUR_MONTH_IDX) {
      // Current month: hand-picked ratio for stable KPI coloring.
      ratio = CUR_MONTH_ACTUAL_RATIOS[sectionGlobalIndex];
    } else {
      // Past/future month: deterministic PRNG in [0.93, 1.01).
      const rng = mulberry32(sectionGlobalIndex * 1000 + i);
      ratio = ACTUAL_RATIO_MIN + rng() * (ACTUAL_RATIO_MAX - ACTUAL_RATIO_MIN);
    }
    const actual = Math.round(plan * ratio);

    months.push({ plan, challenge, actual });
  }
  return months;
}

/**
 * Sum a list of monthly series into one aggregated series (per-month total).
 * Internal helper, not exported.
 */
function sumSeries(nodes: ReadonlyArray<{ months: MonthlyHours[] }>): MonthlyHours[] {
  const result: MonthlyHours[] = [];
  for (let i = 0; i < MONTH_COUNT; i++) {
    let plan = 0;
    let challenge = 0;
    let actual = 0;
    for (const node of nodes) {
      plan += node.months[i].plan;
      challenge += node.months[i].challenge;
      actual += node.months[i].actual;
    }
    result.push({ plan, challenge, actual });
  }
  return result;
}

/** Declarative org spec (department -> sections with base hours), matches v18. */
const ORG_SPEC: ReadonlyArray<{
  name: string;
  sections: ReadonlyArray<{ name: string; base: number }>;
}> = [
  {
    name: '经营企画部',
    sections: [
      { name: '财务课', base: 1045 },
      { name: '企画课', base: 1091 },
    ],
  },
  {
    name: '安全人力资源部',
    sections: [
      { name: '人事课', base: 858 },
      { name: '总务课', base: 1063 },
      { name: '安全环境课', base: 1014 },
      { name: '情报系统课', base: 1012 },
    ],
  },
  {
    name: '生管调达部',
    sections: [
      { name: '调达课', base: 1570 },
      { name: '生产管理1课', base: 1796 },
      { name: '生产管理2课', base: 1654 },
      { name: '制部品管理课', base: 1307 },
    ],
  },
  {
    name: '品质保证部',
    sections: [
      { name: '部品品质课', base: 1188 },
      { name: '品质企画课', base: 889 },
      { name: '品质保证课', base: 1485 },
      { name: '检査课', base: 529 },
    ],
  },
  {
    name: '生产技术部',
    sections: [
      { name: '生产技术1课', base: 1150 },
      { name: '生产技术2课', base: 870 },
      { name: '生产技术3课', base: 2046 },
    ],
  },
  {
    name: '制造支援部',
    sections: [
      { name: '保全课', base: 5698 },
      { name: 'TIE课', base: 1349 },
      { name: '制造企画课', base: 2553 },
    ],
  },
  {
    name: '制造部',
    sections: [
      { name: '生产1课', base: 1018 },
      { name: '生产2课', base: 513 },
      { name: '生产3课', base: 686 },
      { name: '生产4课', base: 684 },
    ],
  },
];

/**
 * Build the full org tree with deterministic monthly data.
 * Sections are numbered top-to-bottom, left-to-right (dept-major order) to
 * form the global index used for PRNG seeding and current-month ratios.
 */
function buildOrg(): OrgRoot {
  const depts: Dept[] = [];
  let sectionGlobalIndex = 0;

  for (const deptSpec of ORG_SPEC) {
    const sections: Section[] = deptSpec.sections.map((secSpec) => {
      const section: Section = {
        name: secSpec.name,
        base: secSpec.base,
        months: buildSectionMonths(secSpec.base, sectionGlobalIndex),
      };
      sectionGlobalIndex += 1;
      return section;
    });

    depts.push({
      name: deptSpec.name,
      sections,
      months: sumSeries(sections),
    });
  }

  return {
    name: '全社',
    depts,
    months: sumSeries(depts),
  };
}

/**
 * Frozen mock org root. Import this wherever the dashboard needs data.
 * Treated as a constant: never mutated after creation.
 */
export const ORG_MOCK: OrgRoot = buildOrg();
