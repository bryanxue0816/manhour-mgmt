/**
 * Server Actions for the monthly 实绩 adjustment sheet (D-233).
 *
 * Two actions: file a month's slips, and revoke one. Everything they decide is decided
 * again here from stored data - nothing the browser posts is trusted as a fact:
 *
 *   * The DELTA is never accepted from the client. The client posts the 人工统计 figure
 *     it was given by a human, and the base is re-read out of the database. A client that
 *     posted its own delta would let a stale tab write a correction against a figure that
 *     changed twenty minutes ago, and the slip would look perfectly ordinary afterwards.
 *   * The BASE the form was rendered with IS posted, but only to be compared. If it no
 *     longer matches, the whole batch is refused - see submitActualAdjustments. The
 *     attendance fold reruns at 09:05 and 15:05 and another operator may file a slip
 *     meanwhile; both move 当前实绩 under a sheet still on screen.
 *   * The HIGH-RISK acknowledgement is a boolean from the client, so it is re-derived
 *     server-side and the batch is refused when confirmation is required and absent. A
 *     checkbox is a statement about a checkbox.
 *   * `now` comes from the server clock, not from the payload. The 只在次月 window is a
 *     rule about when a correction may be filed; letting the caller supply the date would
 *     make it a suggestion.
 *
 * Ordering inside each action is deliberate: requireAdmin() FIRST, before shape
 * validation, so an unauthorised caller learns nothing about the accepted payload. This is
 * also the only place a permission check works at all - a Server Action's id resolves
 * against a global manifest, and on 2026-08-17 every /admin action was successfully
 * invoked by POSTing to the public dashboard. Path-based gating was measured to be
 * bypassable; see tests/security/action-gates.test.ts.
 *
 * Failures are RETURNED, never thrown: a thrown Server Action reaches the browser as an
 * opaque digest in production, and this screen's whole value is telling the operator which
 * of 24 rows it could not read.
 */

"use server";

import { revalidatePath } from "next/cache";

import {
  buildAdjustDraftRows,
  findBaseMismatches,
  planAdjustment,
  type AdjustDraftRow,
} from "@/lib/attendance/adjust-draft";
import { isAdjustable } from "@/lib/attendance/adjust-window";
import { buildActualsView } from "@/lib/attendance/actuals-view";
import { requireAdmin } from "@/lib/auth";
import {
  createActualAdjustmentsBulk,
  revokeActualAdjustment,
} from "@/lib/db/actual-adjustment.repo";
import { findEffectiveActualsByFiscalYear } from "@/lib/db/actual-effective.repo";
import { findFiscalYearByYear } from "@/lib/db/fiscal-year.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import { REASON_MAX_LENGTH } from "@/lib/db/reason";
import type { ActualAdjustmentInput } from "@/lib/db/types";
import { formatHoursValue } from "@/lib/format";

/**
 * Cap on the operator's own reason text, well under REASON_MAX_LENGTH.
 *
 * Each stored reason gets the row's arithmetic appended (see reasonFor). The headroom is
 * what keeps that suffix from being what pushes a legitimate explanation over the limit -
 * an operator should never see 「原因最长 200 字」 for a 150-character sentence because the
 * system silently spent 46 of them.
 */
const ADJUST_REASON_MAX_LENGTH = 120;

/**
 * Upper bound on submitted rows, as a denial-of-service guard rather than a business rule.
 *
 * The sheet has one row per 課 - 24 today. 100 leaves room for the org chart to grow
 * without letting an unbounded payload drive 24 000 iterations of the planner.
 */
const MAX_ENTRY_COUNT = 100;

/** One 課 whose 当前实绩 moved after the form was rendered. */
export interface StaleAdjustRow {
  readonly sectionName: string;
  /** The base the form was rendered with. */
  readonly shown: number;
  /** What the database says now; null when the 課 no longer exists. */
  readonly current: number | null;
}

/** One 課 whose correction is large enough to need saying out loud. */
export interface RiskyAdjustRow {
  readonly sectionName: string;
  readonly baseHours: number;
  readonly manualHours: number;
  /** Signed. */
  readonly delta: number;
  readonly risk: string;
}

export interface SubmitAdjustmentsInput {
  /** Fiscal year number, e.g. 2026 - not the row id, so the window check can own it. */
  fiscalYear: number;
  /** 1..12, where 1 = April. */
  month: number;
  /** Required free-text justification for the batch. */
  reason: string;
  /** 課 id -> exactly what the operator typed. A blank value means "not adjusted". */
  entries: Record<string, string>;
  /**
   * 課 id -> the RAW base number the form was rendered with, for every row being written.
   *
   * Must be the raw number, never the formatted string: formatHoursValue caps at one
   * decimal, so a base of 965.25 round-trips as 965.3 and would report drift on a row
   * nothing had touched.
   */
  bases: Record<string, number>;
  /** True when the operator has confirmed the high-risk rows listed back to them. */
  riskAcknowledged: boolean;
}

export type SubmitAdjustmentsResult =
  | {
      ok: true;
      /** Slips written. 0 with unchangedCount > 0 means "checked, all agreed". */
      written: number;
      unchangedCount: number;
      blankCount: number;
      /** Advisory notes about what WAS written - already prefixed with the 課名. */
      warnings: readonly string[];
    }
  | {
      ok: false;
      message: string;
      /** 課 id -> message, for rows the operator can correct in place. */
      fieldErrors: Readonly<Record<string, string>>;
      /** Non-empty means the sheet is stale and must be reloaded. */
      staleRows: readonly StaleAdjustRow[];
      /** Non-empty means: show these, then resubmit with riskAcknowledged. */
      needsConfirmation: readonly RiskyAdjustRow[];
    };

/** Failure shape helper - keeps the early returns to one line each. */
function reject(
  message: string,
  extra: {
    fieldErrors?: Readonly<Record<string, string>>;
    staleRows?: readonly StaleAdjustRow[];
    needsConfirmation?: readonly RiskyAdjustRow[];
  } = {},
): SubmitAdjustmentsResult {
  return {
    ok: false,
    message,
    fieldErrors: extra.fieldErrors ?? {},
    staleRows: extra.staleRows ?? [],
    needsConfirmation: extra.needsConfirmation ?? [],
  };
}

/**
 * Validates the payload shape.
 *
 * @returns a user-facing message, or `null` when the shape is acceptable. These describe a
 *   malformed request rather than a mistyped number, so they are not attached to a field -
 *   no input on screen can be corrected to fix them.
 */
function checkShape(input: SubmitAdjustmentsInput): string | null {
  if (typeof input !== "object") {
    return "请求格式不合法,请刷新页面后重试。";
  }
  if (typeof input.reason !== "string") {
    return "调整原因格式不合法。";
  }
  if (input.reason.trim() === "") {
    // Same reasoning as D-174 on the plan grid: a correction whose justification is blank
    // leaves a trail recording a change nobody can account for, which is the failure the
    // requirement exists to prevent. The repository refuses it too - this is the message.
    return "请填写调整原因后再提交。";
  }
  if (input.reason.length > ADJUST_REASON_MAX_LENGTH) {
    return `调整原因最长 ${ADJUST_REASON_MAX_LENGTH} 字。`;
  }
  if (typeof input.entries !== "object" || input.entries === null) {
    return "提交内容格式不合法,请刷新页面后重试。";
  }
  if (typeof input.bases !== "object" || input.bases === null) {
    return "提交内容格式不合法,请刷新页面后重试。";
  }
  const keys = Object.keys(input.entries);
  if (keys.length > MAX_ENTRY_COUNT) {
    return `一次最多提交 ${MAX_ENTRY_COUNT} 个课,请刷新页面后重试。`;
  }
  for (const key of keys) {
    if (typeof input.entries[key] !== "string") {
      return "提交内容格式不合法,请刷新页面后重试。";
    }
  }
  return null;
}

/**
 * The reason stored on one slip: the operator's sentence plus the arithmetic behind it.
 *
 * The arithmetic has to go somewhere. `foldHoursAtEntry` records the FOLD at entry, not
 * the base the delta was measured against, so a slip of -45 against a fold of 865 leaves
 * an auditor unable to see that 965 was the figure on screen - the difference being an
 * earlier slip on the same 課-月. Reconstructing it means hand-summing prior un-revoked
 * slips by createdAt. Appending it here makes the row self-explaining at no schema cost.
 */
function reasonFor(reason: string, baseHours: number, manualHours: number): string {
  const suffix =
    `（人工统计 ${formatHoursValue(manualHours)} H` +
    ` − 当前实绩 ${formatHoursValue(baseHours)} H）`;
  // ADJUST_REASON_MAX_LENGTH leaves ample headroom, so this slice should never bite; it is
  // here because the repository has no length guard and an over-long reason would be an
  // unbounded write rather than a caught error.
  return `${reason}${suffix}`.slice(0, REASON_MAX_LENGTH);
}

/** Reads the sheet for one (financial year, month) straight out of the database. */
async function loadDraftRows(
  fiscalYear: { id: string; year: number },
  month: number,
): Promise<readonly AdjustDraftRow[]> {
  const [snapshot, effective] = await Promise.all([
    loadOrgSnapshot(),
    findEffectiveActualsByFiscalYear(fiscalYear.id),
  ]);
  // Through buildActualsView rather than off the merged rows directly, so this sheet and
  // /actuals cannot disagree about 当前实绩 for the same 課-月.
  return buildAdjustDraftRows(buildActualsView(snapshot, effective.rows, fiscalYear), month);
}

/**
 * Files one month's adjustment slips - only for the 課 whose figures actually differ.
 *
 * Nothing is written unless every submitted row can be read, every base still matches, and
 * every high-risk row has been confirmed. All-or-nothing is the point: a half-applied
 * reconciliation leaves totals wrong by an amount nobody can derive without re-reading the
 * hand tally, which is strictly worse than a refusal.
 *
 * A submission where every filled row already agrees with the system returns ok with
 * `written: 0`. That is a real outcome - the operator checked and found no difference - and
 * reporting it as a failure would train them to distrust the screen.
 */
export async function submitActualAdjustments(
  input: SubmitAdjustmentsInput,
): Promise<SubmitAdjustmentsResult> {
  // Gate first, before shape validation: an unauthorised caller must not learn which
  // inputs this action accepts. See src/lib/auth.ts for why the check lives here and not
  // in middleware.
  const gate = await requireAdmin();
  if (!gate.ok) {
    return reject(gate.message);
  }

  const shapeError = checkShape(input);
  if (shapeError !== null) {
    return reject(shapeError);
  }

  // Server clock, never the payload - see the module note. isAdjustable() returns false
  // rather than throwing for a non-integer, so this also covers a garbage month.
  if (!isAdjustable(input.fiscalYear, input.month, new Date())) {
    return reject("该月份不在可调整范围内(仅次月及同财年更早月份)。请刷新页面后重试。");
  }

  const fiscalYear = await findFiscalYearByYear(input.fiscalYear);
  if (fiscalYear === null) {
    return reject(`未找到财年 FY${String(input.fiscalYear)},请刷新页面后重试。`);
  }

  let rows: readonly AdjustDraftRow[];
  try {
    rows = await loadDraftRows(fiscalYear, input.month);
  } catch (error) {
    console.error(
      `[submitActualAdjustments] failed to read fiscalYear=${fiscalYear.id} ` +
        `month=${String(input.month)}`,
      error,
    );
    return reject("读取当前实绩失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  const plan = planAdjustment(rows, new Map(Object.entries(input.entries)));

  if (plan.unknownSectionIds.length > 0) {
    // A submitted 課 that is not on the sheet means the form is from a different org chart
    // - or was forged. Either way the batch cannot be reconciled row-by-row, so none of it
    // is written.
    return reject(
      `提交内容包含未知课别(${plan.unknownSectionIds.join("、")}),请刷新页面后重试。`,
    );
  }

  if (plan.invalid.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const entry of plan.invalid) {
      fieldErrors[entry.sectionId] = entry.message;
    }
    return reject("请修正标红的输入后重试。", { fieldErrors });
  }

  if (plan.writes.length === 0) {
    if (plan.unchangedCount === 0) {
      return reject("请先填写人工统计值,再提交。");
    }
    return {
      ok: true,
      written: 0,
      unchangedCount: plan.unchangedCount,
      blankCount: plan.blankCount,
      warnings: plan.warnings,
    };
  }

  // Only the rows being written are checked for drift. Requiring every one of them to
  // carry a posted base is what makes the check binding: a client that simply omitted the
  // field would otherwise skip verification for exactly the row it wanted to slip through.
  const submittedBases = new Map<string, number>();
  for (const write of plan.writes) {
    const base = input.bases[write.sectionId];
    if (typeof base !== "number" || !Number.isFinite(base)) {
      return reject(`${write.sectionName} 缺少基准值,无法核对。请刷新页面后重试。`);
    }
    submittedBases.set(write.sectionId, base);
  }

  const mismatches = findBaseMismatches(rows, submittedBases);
  if (mismatches.length > 0) {
    // The WHOLE batch is refused, not just the drifted rows. The operator read all 24
    // figures against one hand tally; letting the agreeing rows through would leave a
    // partially reconciled month whose remaining difference nobody can locate.
    return reject(
      "页面数据已过期(当前实绩已变动),本次未写入任何数据。请刷新页面重新核对后再提交。",
      {
        staleRows: mismatches.map((mismatch) => ({
          sectionName: mismatch.sectionName ?? "（课别已删除）",
          shown: mismatch.shown,
          current: mismatch.current,
        })),
      },
    );
  }

  if (plan.risky.length > 0 && input.riskAcknowledged !== true) {
    // Re-derived here rather than trusted from the client, and reported as ONE batch-level
    // confirmation listing the offending rows. Per-row confirmations were rejected on
    // purpose: when a month's fold is missing every row looks risky, and 24 confirmations
    // are worth the same as none.
    return reject("以下课的调整幅度较大,请确认后再提交。", {
      needsConfirmation: plan.risky.map((write) => ({
        sectionName: write.sectionName,
        baseHours: write.baseHours,
        manualHours: write.manualHours,
        delta: write.hours,
        // Non-null by construction: `risky` is the subset whose risk is set.
        risk: write.risk ?? "",
      })),
    });
  }

  const reason = input.reason.trim();
  const inputs: readonly ActualAdjustmentInput[] = plan.writes.map((write) => ({
    sectionId: write.sectionId,
    fiscalYearId: fiscalYear.id,
    month: input.month,
    hours: write.hours,
    reason: reasonFor(reason, write.baseHours, write.manualHours),
  }));

  let written: number;
  try {
    written = await createActualAdjustmentsBulk(inputs);
  } catch (error) {
    console.error(
      `[submitActualAdjustments] bulk insert failed for fiscalYear=${fiscalYear.id} ` +
        `month=${String(input.month)} rows=${String(inputs.length)}`,
      error,
    );
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAfterWrite("submitActualAdjustments");

  return {
    ok: true,
    written,
    unchangedCount: plan.unchangedCount,
    blankCount: plan.blankCount,
    warnings: plan.warnings,
  };
}

export interface RevokeAdjustmentInput {
  id: string;
}

export type RevokeAdjustmentResult = { ok: true } | { ok: false; message: string };

/**
 * Soft-revokes one slip.
 *
 * The repository returns false for "did not exist or was already revoked", and that MUST
 * be surfaced: a swallowed false reads on screen as a successful revoke that never
 * happened, and the hours stay in every total.
 */
export async function revokeAdjustment(
  input: RevokeAdjustmentInput,
): Promise<RevokeAdjustmentResult> {
  const gate = await requireAdmin();
  if (!gate.ok) {
    return { ok: false, message: gate.message };
  }

  if (typeof input?.id !== "string" || input.id.trim() === "") {
    return { ok: false, message: "缺少调整单标识,请刷新页面后重试。" };
  }

  let revoked: boolean;
  try {
    revoked = await revokeActualAdjustment(input.id.trim());
  } catch (error) {
    console.error(`[revokeAdjustment] failed for id=${input.id}`, error);
    return { ok: false, message: "撤销失败,数据未变更。请重试;若持续失败请联系管理员。" };
  }

  if (!revoked) {
    return { ok: false, message: "该调整单不存在或已被撤销,请刷新页面后查看最新状态。" };
  }

  revalidateAfterWrite("revokeAdjustment");
  return { ok: true };
}

/**
 * Refreshes both screens a slip changes, outside the write's try and guarded by its own.
 *
 * The rows are committed by this point, so neither a failure here nor its absence may be
 * reported as 「数据未写入」 - that would send the operator to re-file a correction that is
 * already stored, and this table has no unique key to stop the duplicate.
 */
function revalidateAfterWrite(actionName: string): void {
  try {
    revalidatePath("/actuals");
    revalidatePath("/actuals/adjust");
  } catch (error) {
    console.error(`[${actionName}] revalidatePath failed after a committed write`, error);
  }
}
