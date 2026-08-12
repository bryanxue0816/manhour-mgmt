// FY2026 seed: organisation, fiscal year, job-title rules, config, plans.
//
// Fully idempotent - every write is an upsert keyed on a natural key, so this can
// be re-run against a populated database without raising unique-constraint errors
// and without duplicating rows. That is a hard requirement, not a nicety: D-153
// specifies that org changes arrive as a full Excel re-upload, which makes seed and
// re-import the same write path.
//
// Run with:  npm run db:seed
//
// Source data lives in prisma/seed-data/*.ts, generated from the two source
// spreadsheets by tools/gen-fy26-constants.js. Those files are checked in so that
// a data change produces a reviewable diff, and so seeding needs no xlsx parser at
// runtime.

import { FY26_ORG_ROWS } from "./seed-data/fy26-org";
import { FY26_PLAN_ROWS } from "./seed-data/fy26-plan";
import { fiscalYearEnd, fiscalYearStart, indexToMonth } from "../src/lib/db/date";
import { upsertDepartment, upsertSection } from "../src/lib/db/org.repo";
import { upsertFiscalYear } from "../src/lib/db/fiscal-year.repo";
import { upsertJobTitleRulesBulk } from "../src/lib/db/job-title-rule.repo";
import { upsertSectionAliasesBulk } from "../src/lib/db/section-alias.repo";
import { setConfigBulk } from "../src/lib/db/config.repo";
import { upsertPlansBulk } from "../src/lib/db/plan.repo";
import type { JobTitleRuleDto, PlanUpsertInput, SectionAliasUpsertInput } from "../src/lib/db/types";
import { prisma } from "../src/lib/prisma";

/** FY2026 runs 2026-04-01 .. 2027-03-31. */
const FISCAL_YEAR_NUMBER = 2026;

const FISCAL_YEAR = {
  name: `FY${FISCAL_YEAR_NUMBER}`,
  year: FISCAL_YEAR_NUMBER,
  // Derived from the shared helpers rather than written out as literals, so the
  // April->March boundary is defined in exactly one place (date.ts).
  startDate: fiscalYearStart(FISCAL_YEAR_NUMBER),
  endDate: fiscalYearEnd(FISCAL_YEAR_NUMBER),
  isCurrent: true,
} as const;

/**
 * Job titles whose hours are excluded from a section's aggregate.
 *
 * Managers are budgeted separately from the section they lead: a 部长's personnel
 * and overtime hours both drop out, while a 課長 keeps personnel hours but has
 * overtime excluded (their overtime is not compensated the same way).
 *
 * D-161 added 工场长 and 高级课长 to both lists, taking this from 5 rows to 7. Note
 * that widening the exclusion set does NOT necessarily lower a total: 课长 aggregates
 * to negative overtime in the real data, so excluding it raises the overtime sum.
 */
const JOB_TITLE_RULES: readonly JobTitleRuleDto[] = [
  {
    jobTitle: "部长",
    excludePersonnelHours: true,
    excludeOvertimeHours: true,
    remark: "Department head - budgeted outside the section aggregate.",
  },
  {
    jobTitle: "项目部长",
    excludePersonnelHours: true,
    excludeOvertimeHours: true,
    remark: "Project department head - same treatment as 部长.",
  },
  {
    jobTitle: "副总经理",
    excludePersonnelHours: true,
    excludeOvertimeHours: true,
    remark: "Deputy general manager - excluded from all section aggregates.",
  },
  {
    jobTitle: "工场长",
    excludePersonnelHours: true,
    excludeOvertimeHours: true,
    remark: "Plant manager (D-161) - management post, excluded from both totals.",
  },
  {
    jobTitle: "高级课长",
    excludePersonnelHours: true,
    excludeOvertimeHours: true,
    remark: "Senior section head (D-161) - management post, excluded from both totals.",
  },
  {
    jobTitle: "课长",
    excludePersonnelHours: false,
    excludeOvertimeHours: true,
    remark: "Section head - personnel hours counted, overtime excluded.",
  },
  {
    jobTitle: "项目课长",
    excludePersonnelHours: false,
    excludeOvertimeHours: true,
    remark: "Project section head - same treatment as 课长.",
  },
];

/**
 * HR-export section spellings that do not string-match the org master.
 *
 * The one entry is not a typo on either side: the attendance export writes 检查课
 * (查 = U+67E5) where the org sheet writes 检査课 (査 = U+67FB). Measured on the real
 * workbook, 25 rows a day resolve through this alias; without it the section reports
 * zero actuals and those hours land in the unattributed bucket, with nothing on screen
 * suggesting a spelling problem.
 */
const SECTION_ALIASES: readonly {
  hrDeptName: string;
  hrSectionName: string;
  /** Key into the (dept/section) -> id map built by seedOrg(). */
  sectionKey: string;
  remark: string;
}[] = [
  {
    hrDeptName: "品质保证部",
    hrSectionName: "检查课",
    sectionKey: "品质保证部/检査课",
    remark: "Homoglyph: HR exports 查 U+67E5, org master uses 査 U+67FB.",
  },
];

/**
 * Config rows the seed writes.
 *
 * Deliberately ONE entry (D-169). `current_fiscal_year` used to live here and was
 * removed: `FiscalYear.isCurrent` is the single source of that fact, so a second copy
 * in Config could disagree with it, and nothing read the Config copy anyway - the
 * screens all resolve the current year through findCurrentFiscalYear().
 *
 * `daily_standard_hours` is DORMANT: no code path reads it today. It stays because
 * D-141 fixes 剩余 = 计划 - 实绩 with no working-day denominator, so a per-day standard
 * has no consumer until the v2 threshold work (D-212) gives Config its first real one.
 * Do not add a consumer for it without a decision - see D-169.
 */
const CONFIG_ENTRIES: readonly { key: string; value: string; description?: string }[] = [
  {
    key: "daily_standard_hours",
    value: "8",
    description: "Standard working hours per person per working day. Dormant: no consumer yet (D-169).",
  },
];

/**
 * Writes departments and sections, returning a (dept|dept/section) -> id lookup.
 *
 * Sequential rather than parallel: `FY26_ORG_ROWS` is in spreadsheet order, so a
 * department row always precedes its sections, and each section needs its parent's
 * generated id. 31 upserts is fast enough that the serialisation costs nothing.
 */
async function seedOrg(): Promise<{
  deptIds: Map<string, string>;
  sectionIds: Map<string, string>;
}> {
  const deptIds = new Map<string, string>();
  const sectionIds = new Map<string, string>();

  for (const row of FY26_ORG_ROWS) {
    if (row.section === null) {
      const dept = await upsertDepartment({
        name: row.dept,
        sortOrder: row.rowIndex,
        managerName: row.managerName,
        managerEmail: row.managerEmail,
      });
      deptIds.set(row.dept, dept.id);
      continue;
    }

    const departmentId = deptIds.get(row.dept);
    if (departmentId === undefined) {
      // Only reachable if the generated constants were reordered by hand,
      // breaking the parent-before-child guarantee.
      throw new Error(
        `Section '${row.section}' precedes its department '${row.dept}' in FY26_ORG_ROWS.`,
      );
    }

    const section = await upsertSection({
      departmentId,
      name: row.section,
      sortOrder: row.rowIndex,
      managerName: row.managerName,
      managerEmail: row.managerEmail,
    });
    sectionIds.set(`${row.dept}/${row.section}`, section.id);
  }

  return { deptIds, sectionIds };
}

/**
 * Flattens the 24 section rows into 288 (section, month) plan inputs.
 *
 * `indexToMonth` converts the 0-based array position into the 1-based fiscal month
 * the database stores (month 1 = April); this is the only place in the seed where
 * the two numbering schemes meet.
 */
function buildPlanInputs(
  fiscalYearId: string,
  sectionIds: Map<string, string>,
): PlanUpsertInput[] {
  const inputs: PlanUpsertInput[] = [];

  for (const row of FY26_PLAN_ROWS) {
    const key = `${row.dept}/${row.section}`;
    const sectionId = sectionIds.get(key);
    if (sectionId === undefined) {
      // A plan sheet naming a section absent from the org sheet is a data error
      // worth failing on: silently skipping it would leave the dashboard short a
      // section with no indication why.
      throw new Error(`Plan row references unknown section '${key}'.`);
    }

    if (row.planned.length !== 12 || row.challenge.length !== 12) {
      throw new Error(
        `Plan row '${key}' has ${row.planned.length} planned / ${row.challenge.length} challenge values; expected 12 each.`,
      );
    }

    for (let i = 0; i < 12; i += 1) {
      inputs.push({
        sectionId,
        fiscalYearId,
        month: indexToMonth(i),
        plannedHours: row.planned[i]!,
        challengeHours: row.challenge[i]!,
        updatedBy: "seed",
      });
    }
  }

  return inputs;
}

/**
 * Resolves each alias's target section key into a concrete id.
 *
 * Throws on an unknown key rather than skipping: an alias pointing at a section that no
 * longer exists is the exact failure this table is meant to prevent, and skipping it
 * would restore the silent-zero behaviour with the fix apparently in place.
 */
function buildSectionAliasInputs(
  sectionIds: Map<string, string>,
): SectionAliasUpsertInput[] {
  return SECTION_ALIASES.map((alias) => {
    const sectionId = sectionIds.get(alias.sectionKey);
    if (sectionId === undefined) {
      throw new Error(`Section alias targets unknown section '${alias.sectionKey}'.`);
    }
    return {
      hrDeptName: alias.hrDeptName,
      hrSectionName: alias.hrSectionName,
      sectionId,
      remark: alias.remark,
    };
  });
}

async function main(): Promise<void> {
  console.log("Seeding FY2026...");

  const { deptIds, sectionIds } = await seedOrg();
  console.log(`  organisation : ${deptIds.size} departments, ${sectionIds.size} sections`);

  const fiscalYear = await upsertFiscalYear({ ...FISCAL_YEAR });
  console.log(
    `  fiscal year  : ${fiscalYear.name} (${fiscalYear.startDate.toISOString().slice(0, 10)} .. ${fiscalYear.endDate.toISOString().slice(0, 10)}), isCurrent=${fiscalYear.isCurrent}`,
  );

  const ruleCount = await upsertJobTitleRulesBulk(JOB_TITLE_RULES);
  console.log(`  job titles   : ${ruleCount} rules (expected 7, D-107/D-108 + D-161)`);

  const aliasCount = await upsertSectionAliasesBulk(buildSectionAliasInputs(sectionIds));
  console.log(`  sect aliases : ${aliasCount} rows`);

  const configCount = await setConfigBulk(CONFIG_ENTRIES);
  console.log(`  config       : ${configCount} entries`);

  const planInputs = buildPlanInputs(fiscalYear.id, sectionIds);
  const planCount = await upsertPlansBulk(planInputs);
  console.log(`  plans        : ${planCount} rows (expected 288 = 24 sections x 12 months)`);

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    // Non-zero exit so `npm run db:seed` and any CI step fail loudly rather than
    // reporting success over a half-written database.
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
