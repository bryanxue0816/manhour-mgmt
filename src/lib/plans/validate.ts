// Validation for plan/challenge hour entry (Phase 3).
//
// Layered deliberately, and the split is the whole point of this module:
//
//   * REJECTIONS (`validatePlanCell`, `assertPlanYearComplete`) - values the system
//     cannot represent or store. These throw, or surface as blocking field errors.
//   * WARNINGS (`collectChallengeWarnings`) - values that are unusual but LEGAL.
//     These are reported and saved.
//
// Why `challenge > planned` is a warning and not a rejection:
//
// IMPLEMENTATION_PLAN.md Phase 3 task 3 originally specified a `challenge <= planned`
// check, on the reasoning that a decremental challenge target is the more aggressive
// one and therefore the smaller number. D-151 then established FY26工时计划.xlsx as
// the SINGLE AUTHORITATIVE SOURCE for both values, and schema.prisma records the
// consequence on Plan.challengeHours: "May legally equal or exceed plannedHours".
//
// The real data settles it. Of the 24 sections in that spreadsheet, 4 have
// challenge > planned in all 12 months:
//
//   安全人力资源部 / 人事课        安全人力资源部 / 总务课
//   生管调达部 / 生产管理2课       品质保证部 / 部品品质课
//
// A hard check would make the authoritative source unimportable and would reject the
// 288 rows already seeded from it. So the direction is surfaced, never enforced: the
// administrator sees which cells invert and decides, which is the correct division of
// labour for a value only the business can rule on.
//
// D-151 also explicitly blesses `challenge === planned` (5 sections in 制造部 file it
// that way, "两条线重叠显示"), so equality is not even worth warning about.

import { FISCAL_MONTH_COUNT, assertFiscalMonth } from "@/lib/db/date";
import { assertFiniteHours } from "@/lib/db/hours";
import type { PlanUpsertInput } from "@/lib/db/types";

/** Field of a plan cell that a validation result can refer to. */
export type PlanField = "plannedHours" | "challengeHours";

/** A blocking problem: the value cannot be saved. */
export interface PlanCellError {
  field: PlanField;
  message: string;
}

/** A non-blocking observation: the value is saved, and flagged for review. */
export interface ChallengeWarning {
  sectionId: string;
  /** 1..12, where 1 = April. */
  month: number;
  plannedHours: number;
  challengeHours: number;
}

/**
 * Parses one hour value typed into the grid.
 *
 * Returns `null` for a blank input rather than 0. The distinction is load-bearing:
 * a blank cell means "not yet entered" and must fail completeness, while a genuine
 * 0 is a legal target for a section with no planned work that month. Coercing blank
 * to 0 would make an incomplete year look complete.
 *
 * Rejects non-numeric text, negatives and non-finite values. Note that negatives
 * cannot be delegated to assertFiniteHours(): that guard passes negative values on
 * purpose, because overtime hours are legally negative (D-105). A negative TARGET,
 * by contrast, is meaningless.
 */
export function parseHourInput(raw: string): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: "未录入" };
  }
  // Number() accepts "", "  ", "0x10" and "1e3"; the blank case is handled above and
  // a strict decimal pattern rules out the rest, so no surprising radix parsing.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { error: "只能填非负数字" };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { error: "数值超出可表示范围" };
  }
  return { value };
}

/**
 * Asserts an hour target is finite and non-negative.
 *
 * The non-negative half is specific to targets and is NOT in assertFiniteHours() -
 * see parseHourInput() for why that guard must keep accepting negatives.
 *
 * @throws if the value is not a finite number >= 0.
 */
export function assertNonNegativeHours(field: string, value: number): void {
  assertFiniteHours(field, value);
  if (value < 0) {
    throw new Error(
      `Invalid ${field}: ${value} (a plan target cannot be negative). ` +
        "Negative hours are legal only for overtime deductions (D-105), never for targets.",
    );
  }
}

/**
 * Validates one cell's pair of values, returning every problem found.
 *
 * Returns an array rather than throwing on the first fault so the grid can mark both
 * inputs of a cell at once; a form that reveals one error at a time makes the
 * administrator re-submit to discover the next.
 */
export function validatePlanCell(input: {
  plannedHours: number;
  challengeHours: number;
}): PlanCellError[] {
  const errors: PlanCellError[] = [];
  const fields: readonly PlanField[] = ["plannedHours", "challengeHours"];
  for (const field of fields) {
    try {
      assertNonNegativeHours(field, input[field]);
    } catch (error) {
      errors.push({
        field,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return errors;
}

/**
 * Asserts a section's rows cover all 12 fiscal months exactly once.
 *
 * A missing month is not a cosmetic gap. buildOrgRoot() prefills 12 zero slots and
 * overwrites by index, so an absent month silently reads as a zero target - the
 * dashboard then shows 100% budget consumption for a month nobody planned, with no
 * indication anything is missing. A duplicated month is equally bad: the repo upserts
 * on (sectionId, fiscalYearId, month), so the second row would overwrite the first
 * and one of the two entered values would vanish without an error.
 *
 * @throws if any fiscal month is missing or appears more than once.
 */
export function assertPlanYearComplete(
  rows: readonly { month: number }[],
): void {
  const seen = new Set<number>();
  for (const row of rows) {
    assertFiscalMonth(row.month);
    if (seen.has(row.month)) {
      throw new Error(
        `Duplicate fiscal month ${row.month} in plan year. ` +
          "Rows upsert on (sectionId, fiscalYearId, month); the later row would " +
          "overwrite the earlier one silently.",
      );
    }
    seen.add(row.month);
  }
  const missing: number[] = [];
  for (let month = 1; month <= FISCAL_MONTH_COUNT; month += 1) {
    if (!seen.has(month)) {
      missing.push(month);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Incomplete plan year: missing fiscal month(s) ${missing.join(", ")} ` +
        `(1 = April). A missing month reads as a zero target on the dashboard.`,
    );
  }
}

/**
 * Collects every cell where the challenge target exceeds the planned target.
 *
 * NEVER throws and never filters anything out - the caller saves the data either
 * way. Equality is not reported (D-151 explicitly permits it).
 *
 * @returns one entry per inverted cell, in input order.
 */
export function collectChallengeWarnings(
  rows: readonly PlanUpsertInput[],
): ChallengeWarning[] {
  const warnings: ChallengeWarning[] = [];
  for (const row of rows) {
    if (row.challengeHours > row.plannedHours) {
      warnings.push({
        sectionId: row.sectionId,
        month: row.month,
        plannedHours: row.plannedHours,
        challengeHours: row.challengeHours,
      });
    }
  }
  return warnings;
}

/**
 * Human-readable summary of a warning set, for the page banner.
 * @returns `null` when there is nothing to report, so the caller can skip the banner.
 */
export function summariseChallengeWarnings(
  warnings: readonly ChallengeWarning[],
): string | null {
  if (warnings.length === 0) {
    return null;
  }
  const sections = new Set(warnings.map((warning) => warning.sectionId));
  return (
    `${sections.size} 个课共 ${warnings.length} 个格子的挑战工时高于计划工时。` +
    "已按 D-151 原样保存,仅作提示,请确认是否符合业务预期。"
  );
}
