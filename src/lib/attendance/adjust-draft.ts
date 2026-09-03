/**
 * The decision layer behind the monthly 实绩 adjustment sheet (D-233).
 *
 * The screen's purpose is COMPARISON, not entry: all 24 課 are listed for the chosen
 * month so a human can read the machine's figure next to their own hand tally. Only the
 * rows where the two disagree become slips. Everything here is the arithmetic and the
 * judgement calls behind that sentence, kept prisma-free - same split as actuals-view.ts -
 * so the Server Action and the client form share one definition of "what would be
 * written" instead of each computing their own.
 *
 * Four rules are load-bearing. Each one, if wrong, produces a plausible-looking number:
 *
 *   * The subtraction base is 当前实绩 (折算 ＋ 已有未撤销调整), never the raw fold. A 課
 *     folded at 865 that already carries a +100 slip reads 965 today, so a hand tally of
 *     920 is -45. Subtracting from the fold gives +55: wrong sign, wrong size, and
 *     entirely reasonable-looking in the audit log. This is also why 「已有调整」 is a
 *     permanent column on the sheet rather than a detail behind a toggle - it is an
 *     arithmetic prerequisite for reading the 差额 column, not a courtesy.
 *   * Blank and 0 are different answers. Blank means "this 課 was not adjusted"; 0 means
 *     "the hand tally is zero", which zeroes the 課. parseHourInput() cannot be reused
 *     here for exactly that reason: it reports blank as an error.
 *   * The operator types an unsigned tally and the system derives the sign. Nobody should
 *     be asked to type -45 and be relied on to get the direction right.
 *   * A delta of 1e-13 is not a delta. `adjustedMonths` is slip-driven rather than
 *     value-derived, so a float-residue slip would leave a permanent △ marker on /actuals
 *     for a month in which nothing actually changed - and no screen would ever explain it.
 */

import type { ActualsView } from "@/lib/attendance/actuals-view";
import { assertFiscalMonth } from "@/lib/db/date";
import { formatHoursValue, formatSignedHours } from "@/lib/format";

/**
 * Below this, a difference is float residue rather than a correction.
 *
 * 0.005 is half of the smallest figure the screen can display (one decimal place), so
 * anything smaller is invisible to the operator anyway - writing a slip for it would put
 * a marker on the month that nobody can account for by looking.
 */
export const DELTA_EPSILON = 0.005;

/** A correction of half the current 实绩 or more asks for confirmation. */
export const HIGH_RISK_DELTA_RATIO = 0.5;

/** Same reasoning as DELTA_EPSILON, applied to the stale-base check. */
export const BASE_DRIFT_TOLERANCE = 0.005;

/** Attendance hours arrive in 0.5 steps, so a delta off that grid is worth a second look. */
const HOUR_STEP = 0.5;

/** What the operator typed in one 人工统计 field. */
export type ManualEntry =
  | { readonly kind: "blank" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "value"; readonly hours: number };

/** One 課's line on the sheet, before the operator has typed anything. */
export interface AdjustDraftRow {
  readonly sectionId: string;
  readonly sectionName: string;
  readonly departmentName: string;
  /** What the attendance fold produced, or the D-198 hand-loaded baseline. */
  readonly foldHours: number;
  /** Signed sum of un-revoked slips already on this (課, 月). */
  readonly existingAdjustment: number;
  /** 当前实绩 - the figure the new delta is measured against. */
  readonly baseHours: number;
  /** False when the month was never imported: renders 尚未导入, not 0. */
  readonly present: boolean;
  readonly isManualBaseline: boolean;
  readonly foldChangedSinceAdjustment: boolean;
}

/** What one filled-in row amounts to. */
export type DraftVerdict =
  | { readonly kind: "blank" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unchanged"; readonly delta: number }
  | {
      readonly kind: "write";
      /** The signed figure that gets stored. */
      readonly delta: number;
      /** Non-null when this row needs an explicit confirmation. */
      readonly risk: string | null;
      /** Advisory only - never blocks a submission. */
      readonly warnings: readonly string[];
    };

/** One slip that would be written. */
export interface AdjustWrite {
  readonly sectionId: string;
  readonly sectionName: string;
  /** The signed delta - this is what lands in ActualAdjustment.hours. */
  readonly hours: number;
  readonly baseHours: number;
  readonly manualHours: number;
  readonly risk: string | null;
  readonly warnings: readonly string[];
}

/** One field that could not be read. */
export interface AdjustInvalidEntry {
  readonly sectionId: string;
  readonly sectionName: string;
  readonly raw: string;
  readonly message: string;
}

/** The whole sheet, resolved. */
export interface AdjustPlan {
  /** In sheet order, so the confirmation dialog reads the same way as the table. */
  readonly writes: readonly AdjustWrite[];
  readonly invalid: readonly AdjustInvalidEntry[];
  /** Filled in and identical to 当前实绩 - a confirmation, not an adjustment. */
  readonly unchangedCount: number;
  readonly blankCount: number;
  /** The subset of `writes` needing confirmation. */
  readonly risky: readonly AdjustWrite[];
  /** Advisory messages, already prefixed with the 課名. */
  readonly warnings: readonly string[];
  /** Submitted 課 that are not on the sheet - a forged or stale field. */
  readonly unknownSectionIds: readonly string[];
}

/** A stale base: what the form showed versus what the database says now. */
export interface BaseMismatch {
  readonly sectionId: string;
  /** null when the 課 is no longer on the sheet. */
  readonly sectionName: string | null;
  readonly shown: number;
  /** null when the 課 is no longer on the sheet. */
  readonly current: number | null;
}

/**
 * Two decimal places, with negative zero normalised to zero.
 *
 * Hours are 0.5-stepped, so two decimals cannot lose a real digit; what it removes is the
 * 100.10000000000036 that 3000.3 - 2900.2 produces in IEEE 754. Stored raw, that value
 * displays as 100.1 on every screen while never actually equalling 100.1.
 *
 * The `=== 0` branch returns a literal +0 rather than the result of the division, because
 * Math.round(-0.001) is -0 and Intl.NumberFormat has rendered -0 as "-0" since ES2020 -
 * a 「-0.0」 on screen reads as a tiny reduction that did not happen.
 */
function round2(value: number): number {
  const scaled = Math.round(value * 100);
  return scaled === 0 ? 0 : scaled / 100;
}

/**
 * Full-width digits and punctuation to ASCII.
 *
 * A Chinese IME emits `９２０`, and Number("９２０") is NaN. Unhandled, that rejects a
 * tally which looks perfectly correct on screen, with no way for the operator to see the
 * difference. Both full-width stops are mapped because an IME left in Chinese punctuation
 * mode produces 。 where a decimal point was intended.
 */
function toAsciiDigits(raw: string): string {
  return raw.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  )
    .replace(/[．。]/g, ".")
    .replace(/－/g, "-")
    .replace(/，/g, ",");
}

/**
 * Read one 人工统计 field.
 *
 * Deliberately NOT parseHourInput() (lib/plans/validate.ts): that function reports an
 * empty field as the error 「未录入」, and on this screen an empty field is the normal,
 * correct state of twenty-odd rows.
 *
 * The pattern is strict rather than a bare Number() call because Number() quietly accepts
 * things a hand-written tally never is: Number("") is 0, Number("0x10") is 16,
 * Number("1e3") is 1000. Any of those becoming an accepted figure would be a wrong number
 * written with no complaint.
 */
export function parseManualEntry(raw: string): ManualEntry {
  const trimmed = toAsciiDigits(raw).replace(/[\s　]/g, "");
  if (trimmed === "") return { kind: "blank" };
  if (trimmed.includes(",")) {
    // "1,000" pasted out of Excel is the likely form, and parsing it as 1 would be
    // catastrophic and silent. Say what to remove rather than just 「格式错误」.
    return { kind: "invalid", message: "请去掉千位分隔符，直接填数字（例：1000）" };
  }
  if (trimmed.startsWith("-")) {
    return {
      kind: "invalid",
      message: "请填人工统计的工时数（正数），差额的正负由系统计算",
    };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: "invalid", message: "只能填数字，例：920 或 920.5" };
  }
  const hours = Number(trimmed);
  if (!Number.isFinite(hours)) {
    return { kind: "invalid", message: "数值超出可表示范围" };
  }
  return { kind: "value", hours };
}

/**
 * One line per 課 for the given fiscal month - all of them, every month.
 *
 * Built off ActualsView rather than querying, so this sheet and /actuals cannot report
 * different 实绩 for the same (課, 月): they read the same rows through the same fold.
 *
 * @throws if `month` is not an integer in 1..12.
 */
export function buildAdjustDraftRows(
  view: ActualsView,
  month: number,
): readonly AdjustDraftRow[] {
  assertFiscalMonth(month);
  return view.rows.map((row) => {
    const cell = row.cells.find((candidate) => candidate.month === month);
    if (!cell) {
      throw new Error(`${row.sectionName} 缺少第 ${String(month)} 月的单元格`);
    }
    return {
      sectionId: row.sectionId,
      sectionName: row.sectionName,
      departmentName: row.departmentName,
      foldHours: cell.totalHours,
      existingAdjustment: cell.adjustmentHours,
      // effectiveHours rather than totalHours + adjustmentHours: 实绩 is defined in one
      // place (D-141) and re-deriving it here would create a second definition free to
      // drift from the one every other screen displays.
      baseHours: cell.effectiveHours,
      present: cell.present,
      isManualBaseline: cell.isManualBaseline,
      foldChangedSinceAdjustment: cell.foldChangedSinceAdjustment,
    };
  });
}

/** Why this row needs confirmation, or null when it is a routine correction. */
function assessRisk(row: AdjustDraftRow, manualHours: number, delta: number): string | null {
  // A base of 0 is not risky. If a month's fold never arrived - the standing D-207 case -
  // every one of the 24 rows would have base 0, and 24 confirmations is the same as none.
  if (row.baseHours === 0) return null;
  if (manualHours === 0) {
    // Mechanically a subset of the ratio rule below (|delta| equals |base| when the tally
    // is 0), but it needs its own wording: one keystroke wipes the 課 out, and on screen
    // that is indistinguishable from a slip of the finger.
    return `人工统计填 0，本课实绩将由 ${formatHoursValue(row.baseHours)} H 归零`;
  }
  const ratio = Math.abs(delta) / Math.abs(row.baseHours);
  if (ratio >= HIGH_RISK_DELTA_RATIO) {
    return (
      `差额 ${formatSignedHours(delta)} H 达当前实绩 ${formatHoursValue(row.baseHours)} H 的 ` +
      `${String(Math.round(ratio * 100))}%`
    );
  }
  return null;
}

/** Advisory notes - these never block a submission. */
function collectWarnings(delta: number): readonly string[] {
  const steps = delta / HOUR_STEP;
  if (Math.abs(steps - Math.round(steps)) <= DELTA_EPSILON) return [];
  // Warn on the DELTA, not on the entered tally: the delta is the figure stored and read
  // back by a later auditor. Warn rather than reject, because nothing in this repo
  // enforces 0.5 steps and the adjustment tests deliberately store -12.5.
  return [`差额 ${formatSignedHours(delta)} H 不是 0.5 的整数倍，请确认人工统计值`];
}

/** What one row amounts to, given what the operator typed into it. */
export function evaluateDraftRow(row: AdjustDraftRow, raw: string): DraftVerdict {
  const entry = parseManualEntry(raw);
  if (entry.kind === "blank") return { kind: "blank" };
  if (entry.kind === "invalid") return { kind: "invalid", message: entry.message };

  const delta = round2(entry.hours - row.baseHours);
  if (Math.abs(delta) < DELTA_EPSILON) {
    // Filled in and identical: the operator confirmed the number. A confirmation is not
    // an adjustment, and the repository rejects hours === 0 anyway.
    return { kind: "unchanged", delta: 0 };
  }
  return {
    kind: "write",
    delta,
    risk: assessRisk(row, entry.hours, delta),
    warnings: collectWarnings(delta),
  };
}

/**
 * Resolve the whole sheet: what would be written, what cannot be read, what to confirm.
 *
 * @param entries 課 id -> the raw string in that row's field. A row absent from the map is
 *   treated as blank, because a form may omit an untouched field rather than post "".
 */
export function planAdjustment(
  rows: readonly AdjustDraftRow[],
  entries: ReadonlyMap<string, string>,
): AdjustPlan {
  const writes: AdjustWrite[] = [];
  const invalid: AdjustInvalidEntry[] = [];
  const warnings: string[] = [];
  let unchangedCount = 0;
  let blankCount = 0;

  // Iterating `rows` rather than `entries` is what keeps `writes` in sheet order: the
  // confirmation dialog and the table have to read top-to-bottom the same way, or the
  // operator checks the wrong line.
  for (const row of rows) {
    const verdict = evaluateDraftRow(row, entries.get(row.sectionId) ?? "");
    switch (verdict.kind) {
      case "blank":
        blankCount += 1;
        break;
      case "unchanged":
        unchangedCount += 1;
        break;
      case "invalid":
        invalid.push({
          sectionId: row.sectionId,
          sectionName: row.sectionName,
          raw: entries.get(row.sectionId) ?? "",
          message: verdict.message,
        });
        break;
      case "write":
        writes.push({
          sectionId: row.sectionId,
          sectionName: row.sectionName,
          hours: verdict.delta,
          baseHours: row.baseHours,
          manualHours: round2(row.baseHours + verdict.delta),
          risk: verdict.risk,
          warnings: verdict.warnings,
        });
        for (const warning of verdict.warnings) {
          warnings.push(`${row.sectionName}：${warning}`);
        }
        break;
    }
  }

  const known = new Set(rows.map((row) => row.sectionId));
  // Only NON-BLANK unknown entries are reported. A 課 removed between page load and
  // submit leaves a blank field, and dropping that is correct - there is nothing to
  // write. Dropping a FILLED one would report success for a write that never happened.
  const unknownSectionIds = [...entries]
    .filter(([sectionId, raw]) => !known.has(sectionId) && parseManualEntry(raw).kind !== "blank")
    .map(([sectionId]) => sectionId);

  return {
    writes,
    invalid,
    unchangedCount,
    blankCount,
    risky: writes.filter((write) => write.risk !== null),
    warnings,
    unknownSectionIds,
  };
}

/**
 * Rows whose base moved after the form was rendered.
 *
 * The attendance fold reruns at 09:05 and 15:05, and another operator may file a slip in
 * the meantime. Either one changes 当前实绩 under a sheet that is still on screen, and a
 * delta computed from the stale base is wrong by exactly the amount it moved - with
 * nothing on screen to suggest it.
 *
 * Only the SUBMITTED rows are checked. Drift on an untouched 課 has no bearing on the
 * batch, and letting it block one would make the sheet unusable on fold days.
 *
 * @param shown 課 id -> the base the form was rendered with. Pass the raw number the page
 *   emitted, never the formatted display string: 965.25 renders as "965.3" at one decimal
 *   place, and parsing that back would report drift on a row nothing had touched.
 */
export function findBaseMismatches(
  rows: readonly AdjustDraftRow[],
  shown: ReadonlyMap<string, number>,
): readonly BaseMismatch[] {
  const byId = new Map(rows.map((row) => [row.sectionId, row]));
  const mismatches: BaseMismatch[] = [];
  for (const [sectionId, shownBase] of shown) {
    const row = byId.get(sectionId);
    if (!row) {
      mismatches.push({ sectionId, sectionName: null, shown: shownBase, current: null });
      continue;
    }
    if (Math.abs(row.baseHours - shownBase) > BASE_DRIFT_TOLERANCE) {
      mismatches.push({
        sectionId,
        sectionName: row.sectionName,
        shown: shownBase,
        current: row.baseHours,
      });
    }
  }
  return mismatches;
}
