// Server Actions for the plan-entry grid (D-142 page-level single-cell editing).
//
// One action, one cell. The write goes through upsertPlanWithAudit() so every edit
// leaves a PlanChangeLog trail (D-143) in the same transaction as the value change.
//
// Two deliberate choices about the boundary:
//
//   1. The action takes RAW STRINGS, not numbers. parseHourInput() is what produces
//      the messages the grid shows ("未录入", "只能填非负数字"), and it can only do
//      that from the text the administrator actually typed. Coercing to a number in
//      the browser would turn "abc" into NaN and blank into 0 before the layer that
//      knows what those mean gets to see them.
//
//   2. It RETURNS failures instead of throwing them. A Server Action that throws
//      reaches the client as an opaque digest in production, so the grid could only
//      say "something went wrong". Returning a discriminated result lets the cell
//      mark the offending field and keep the administrator's typing.
//
// Server Actions are public HTTP endpoints - the browser is not a trust boundary -
// so the shape of the payload is validated here rather than assumed from the types.

"use server";

import { revalidatePath } from "next/cache";

import { FISCAL_MONTH_COUNT } from "@/lib/db/date";
import { upsertPlanWithAudit } from "@/lib/db/plan.repo";
import {
  parseHourInput,
  validatePlanCell,
  type PlanCellError,
  type PlanField,
} from "@/lib/plans/validate";

/**
 * Identity recorded on the row and in the audit trail.
 *
 * A constant because v1 has no account system: D-008 settles on intranet IP
 * allow-listing, and D-142 narrows the audience to 1-2 administrators. The audit
 * trail is therefore "when and what", not "who" - which is what D-143 asks for.
 * When an identity source arrives this becomes a lookup, and PlanChangeLog needs no
 * schema change to benefit.
 */
const PLAN_EDITOR = "admin";

/** Guards the required free-text reason against an unbounded write. */
const REASON_MAX_LENGTH = 200;

/** The two editable quantities, in display order. */
const PLAN_FIELDS: readonly PlanField[] = ["plannedHours", "challengeHours"];

export interface SavePlanCellInput {
  sectionId: string;
  fiscalYearId: string;
  /** 1..12, where 1 = April. */
  month: number;
  /** Exactly what the administrator typed - see the module note. */
  plannedRaw: string;
  challengeRaw: string;
  /**
   * Required justification, stored on every audit entry this edit produces (D-143).
   *
   * Required as of D-174, and enforced in checkShape() rather than only in the dialog:
   * a Server Action is a public HTTP endpoint, so a client-side `required` is a hint to
   * the operator, not a guarantee to the audit trail.
   */
  reason: string;
}

export type SavePlanCellResult =
  | {
      ok: true;
      plannedHours: number;
      challengeHours: number;
      /** False when the row did not exist; a first insert logs nothing (D-143). */
      updated: boolean;
      /** Audit entries appended. 0 means the submitted values matched the stored ones. */
      loggedChanges: number;
      /** True when challengeHours > plannedHours - legal under D-151, saved either way. */
      inverted: boolean;
    }
  | {
      ok: false;
      message: string;
      /**
       * Per-field problems. Non-empty means the input is correctable, so the grid
       * keeps the draft; empty means the write itself failed and the grid reverts.
       */
      fieldErrors: Partial<Record<PlanField, string>>;
    };

/** Failure shape helper - keeps the early returns to one line each. */
function reject(
  message: string,
  fieldErrors: Partial<Record<PlanField, string>> = {},
): SavePlanCellResult {
  return { ok: false, message, fieldErrors };
}

/**
 * Validates the payload shape.
 *
 * @returns a user-facing message, or `null` when the shape is acceptable. These
 *   messages describe a malformed request rather than a mistyped number, so they are
 *   not attached to a field: no input on screen can be corrected to fix them.
 */
function checkShape(input: SavePlanCellInput): string | null {
  if (typeof input?.sectionId !== "string" || input.sectionId.trim() === "") {
    return "缺少课标识,请刷新页面后重试。";
  }
  if (typeof input.fiscalYearId !== "string" || input.fiscalYearId.trim() === "") {
    return "缺少财年标识,请刷新页面后重试。";
  }
  if (
    !Number.isInteger(input.month) ||
    input.month < 1 ||
    input.month > FISCAL_MONTH_COUNT
  ) {
    return `月份 ${String(input.month)} 不在 1..${FISCAL_MONTH_COUNT} 范围内(1 = 4月)。`;
  }
  if (typeof input.plannedRaw !== "string" || typeof input.challengeRaw !== "string") {
    return "输入格式不合法,请刷新页面后重试。";
  }
  if (typeof input.reason !== "string") {
    return "修改原因格式不合法。";
  }
  if (input.reason.trim() === "") {
    // D-174: an edit without a stated reason is refused outright. Writing the row and
    // logging an empty reason would leave a trail that records a change nobody can
    // explain, which is the exact failure the requirement exists to prevent.
    return "请填写修改原因后再保存。";
  }
  if (input.reason.length > REASON_MAX_LENGTH) {
    return `修改原因最长 ${REASON_MAX_LENGTH} 字。`;
  }
  return null;
}

/** Folds validatePlanCell()'s list into the per-field map the grid consumes. */
function toFieldErrors(
  errors: readonly PlanCellError[],
): Partial<Record<PlanField, string>> {
  const fieldErrors: Partial<Record<PlanField, string>> = {};
  for (const error of errors) {
    // First message wins: validatePlanCell reports at most one per field today, and
    // if that ever changes the earliest is the most specific.
    if (fieldErrors[error.field] === undefined) {
      fieldErrors[error.field] = error.message;
    }
  }
  return fieldErrors;
}

/**
 * Saves one (section, fiscal year, month) cell: both quantities, one audit trail.
 *
 * Both values are written on every call even when only one changed. That is not
 * waste - the row's two columns are NOT NULL and the composite key is the row, so a
 * "planned only" write would still have to supply a challenge value. diffPlanChange()
 * compares against the stored pair, so the unchanged half logs nothing.
 *
 * Never throws for a foreseeable cause. An unexpected throw is logged server-side
 * and returned as a generic message: the underlying text can name tables and
 * constraints, which does not belong in a browser response.
 */
export async function savePlanCell(
  input: SavePlanCellInput,
): Promise<SavePlanCellResult> {
  const shapeError = checkShape(input);
  if (shapeError !== null) {
    return reject(shapeError);
  }

  const parsed = {
    plannedHours: parseHourInput(input.plannedRaw),
    challengeHours: parseHourInput(input.challengeRaw),
  } as const;

  const parseErrors: Partial<Record<PlanField, string>> = {};
  for (const field of PLAN_FIELDS) {
    const result = parsed[field];
    if ("error" in result) {
      parseErrors[field] = result.error;
    }
  }
  if (Object.keys(parseErrors).length > 0) {
    // A cell is a pair: both columns are NOT NULL, so half a cell cannot be stored.
    // Reporting the blank half as "未录入" is why parseHourInput refuses to read a
    // blank input as 0 - see its docstring.
    return reject("请修正标红的输入后重试。", parseErrors);
  }

  // Both parses succeeded; `in` narrowing above does not survive the loop, so read
  // the values back through the same guard rather than casting.
  if ("error" in parsed.plannedHours || "error" in parsed.challengeHours) {
    return reject("请修正标红的输入后重试。", parseErrors);
  }
  const plannedHours = parsed.plannedHours.value;
  const challengeHours = parsed.challengeHours.value;

  const cellErrors = validatePlanCell({ plannedHours, challengeHours });
  if (cellErrors.length > 0) {
    return reject("请修正标红的输入后重试。", toFieldErrors(cellErrors));
  }

  // Non-empty by checkShape(); trimmed so trailing whitespace never reaches the log.
  const reason = input.reason.trim();

  let written: Awaited<ReturnType<typeof upsertPlanWithAudit>>;
  try {
    written = await upsertPlanWithAudit({
      sectionId: input.sectionId,
      fiscalYearId: input.fiscalYearId,
      month: input.month,
      plannedHours,
      challengeHours,
      changedBy: PLAN_EDITOR,
      reason,
    });
  } catch (error) {
    console.error(
      `[savePlanCell] failed for section=${input.sectionId} ` +
        `fiscalYear=${input.fiscalYearId} month=${String(input.month)}`,
      error,
    );
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  // Outside the write's try, and guarded by its own: the row is committed by this
  // point, so neither a failure here nor its absence may be reported as "数据未写入" -
  // that would send the operator to re-enter a number that is already stored. The
  // page's totals, completeness count and D-151 banner are derived from the whole
  // fiscal year, so they cannot be corrected from one cell's result and do need the
  // revalidate; a stale total is a cosmetic problem that the next navigation fixes.
  try {
    revalidatePath("/plans");
  } catch (error) {
    console.error("[savePlanCell] revalidatePath failed after a committed write", error);
  }

  return {
    ok: true,
    plannedHours,
    challengeHours,
    updated: !written.created,
    loggedChanges: written.loggedChanges,
    inverted: challengeHours > plannedHours,
  };
}
