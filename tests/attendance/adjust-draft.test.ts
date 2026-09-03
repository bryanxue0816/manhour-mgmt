// D-233 / D-239: the pure decision layer behind /actuals/adjust.
//
// The screen's job is comparison, not entry: all 24 課 are listed for every month so
// a human can read the machine's number next to their own hand tally. Only the rows
// where those two disagree turn into a slip. Everything in this file is the
// arithmetic and the judgement calls behind that sentence, kept prisma-free so it can
// be tested without a database - the same split as actuals-view.ts.
//
// Four rules here are load-bearing and each one is a bug that would be invisible on
// screen if it were wrong:
//
//   * The subtraction base is 当前实绩 (折算 + 已有未撤销调整), never the raw fold.
//     A section folded at 865 that already carries a +100 slip reads 965 today, so a
//     hand tally of 920 is -45. Subtracting from the fold would write +55: wrong
//     sign, wrong size, and it looks perfectly reasonable in the audit log.
//   * Blank and 0 are different answers. Blank means "this 課 was not adjusted"; 0
//     means "the hand tally is zero", which zeroes the section.
//   * The operator types an unsigned tally. The sign is derived. Nobody should ever
//     be asked to type -45 and get it right.
//   * A delta of 1e-13 is not a delta. adjustedMonths is slip-driven rather than
//     value-derived, so a float-residue slip would leave a permanent △ marker on
//     /actuals for a month where nothing actually changed.

import { describe, expect, it } from "vitest";

import { buildActualsView } from "@/lib/attendance/actuals-view";
import {
  buildAdjustDraftRows,
  evaluateDraftRow,
  findBaseMismatches,
  parseManualEntry,
  planAdjustment,
} from "@/lib/attendance/adjust-draft";
import type { ActualEffectiveRow, OrgSnapshot } from "@/lib/db/types";

const FY = { id: "fy-2026", year: 2026 };

/** Same three-section fixture as actuals-view.test.ts - grouping plus row order. */
const SNAPSHOT: OrgSnapshot = {
  departments: [
    { id: "dept-qa", name: "品质保证部", code: null, sortOrder: 4, managerName: null, managerEmail: null },
    { id: "dept-mfg", name: "制造部", code: null, sortOrder: 7, managerName: null, managerEmail: null },
  ],
  sections: [
    { id: "sec-inspect", departmentId: "dept-qa", name: "检查课", sortOrder: 1, managerName: null, managerEmail: null },
    { id: "sec-quality", departmentId: "dept-qa", name: "品质课", sortOrder: 2, managerName: null, managerEmail: null },
    { id: "sec-assy", departmentId: "dept-mfg", name: "组装课", sortOrder: 1, managerName: null, managerEmail: null },
  ],
};

function actual(
  overrides: Partial<ActualEffectiveRow> & Pick<ActualEffectiveRow, "sectionId" | "month">,
): ActualEffectiveRow {
  const totalHours = overrides.totalHours ?? 0;
  const adjustmentHours = overrides.adjustmentHours ?? 0;
  return {
    fiscalYearId: FY.id,
    personnelHours: 0,
    overtimeHours: 0,
    totalHours,
    adjustmentHours,
    effectiveHours: totalHours + adjustmentHours,
    foldChangedSinceAdjustment: false,
    source: "fold",
    ...overrides,
  };
}

function viewOf(rows: readonly ActualEffectiveRow[]) {
  return buildActualsView(SNAPSHOT, rows, FY);
}

/** A single draft row, built through the real view so the fixture cannot drift. */
function rowOf(overrides: Partial<ActualEffectiveRow> = {}) {
  const view = viewOf([actual({ sectionId: "sec-inspect", month: 5, ...overrides })]);
  const rows = buildAdjustDraftRows(view, 5);
  const row = rows[0];
  if (!row) throw new Error("fixture produced no rows");
  return row;
}

describe("buildAdjustDraftRows", () => {
  it("lists every 課 even for a month with no data at all", () => {
    // The primary requirement: the screen is a comparison sheet. A 課 missing from
    // the list is a 課 whose hand tally nobody checks.
    const rows = buildAdjustDraftRows(viewOf([]), 5);

    expect(rows.map((row) => row.sectionId)).toEqual([
      "sec-inspect",
      "sec-quality",
      "sec-assy",
    ]);
  });

  it("carries the section and department names for display", () => {
    const rows = buildAdjustDraftRows(viewOf([]), 5);

    expect(rows[0]?.sectionName).toBe("检查课");
    expect(rows[0]?.departmentName).toBe("品质保证部");
  });

  it("uses 当前实绩 as the base, not the raw fold", () => {
    // The worked example the operator was shown: fold 865, existing slip +100, so
    // today's 实绩 is 965. Subtracting from 865 instead would invert the sign.
    const row = rowOf({ totalHours: 865, adjustmentHours: 100 });

    expect(row.foldHours).toBe(865);
    expect(row.existingAdjustment).toBe(100);
    expect(row.baseHours).toBe(965);
  });

  it("keeps the base equal to the fold when no slip exists", () => {
    const row = rowOf({ totalHours: 865 });

    expect(row.existingAdjustment).toBe(0);
    expect(row.baseHours).toBe(865);
  });

  it("reports an unimported month as absent rather than as zero", () => {
    // present === false and a genuine 0 look identical in the 折算 column. Only this
    // flag lets the screen say 尚未导入 instead of implying the 課 worked no hours.
    const rows = buildAdjustDraftRows(viewOf([]), 5);

    expect(rows[0]?.present).toBe(false);
    expect(rows[0]?.baseHours).toBe(0);
  });

  it("marks a manual-baseline month", () => {
    // D-198 months carry no 人员/加班 breakdown, and the UI has to say so - but a
    // slip is still allowed, because no screen can edit the baseline itself.
    const row = rowOf({ totalHours: 32027.5, source: "manual" });

    expect(row.isManualBaseline).toBe(true);
    expect(row.present).toBe(true);
  });

  it("carries the fold-drift flag through untouched", () => {
    const row = rowOf({ totalHours: 900, adjustmentHours: 50, foldChangedSinceAdjustment: true });

    expect(row.foldChangedSinceAdjustment).toBe(true);
  });

  it("throws on a month outside 1..12", () => {
    expect(() => buildAdjustDraftRows(viewOf([]), 0)).toThrow();
    expect(() => buildAdjustDraftRows(viewOf([]), 13)).toThrow();
  });
});

describe("parseManualEntry", () => {
  it("treats an empty field as 未调整, not as an error", () => {
    // Blank is the normal state of 20-odd rows on this screen. parseHourInput()
    // cannot be reused precisely because it calls blank an error.
    expect(parseManualEntry("")).toEqual({ kind: "blank" });
    expect(parseManualEntry("   ")).toEqual({ kind: "blank" });
  });

  it("reads a plain tally", () => {
    expect(parseManualEntry("920")).toEqual({ kind: "value", hours: 920 });
    expect(parseManualEntry("920.5")).toEqual({ kind: "value", hours: 920.5 });
    expect(parseManualEntry(" 920 ")).toEqual({ kind: "value", hours: 920 });
  });

  it("reads 0 as the number zero, not as blank", () => {
    // The distinction the whole design rests on: 0 means "the hand tally is zero".
    expect(parseManualEntry("0")).toEqual({ kind: "value", hours: 0 });
  });

  it("normalises full-width digits from a Chinese IME", () => {
    // Number("９２０") is NaN. Left unhandled this rejects a tally that looks
    // completely correct on screen, and the operator has no way to tell why.
    expect(parseManualEntry("９２０")).toEqual({ kind: "value", hours: 920 });
    expect(parseManualEntry("９２０．５")).toEqual({ kind: "value", hours: 920.5 });
  });

  it("rejects a negative tally", () => {
    // The operator types what they counted; the system derives the sign. Accepting
    // -45 here would let a slip be double-negated with no way to see it.
    const result = parseManualEntry("-45");

    expect(result.kind).toBe("invalid");
  });

  it("rejects a thousands separator with an actionable message", () => {
    // "1,000" pasted out of Excel is the likely form. Silently parsing it as 1 would
    // be catastrophic, so say what to remove rather than just "格式错误".
    const result = parseManualEntry("1,000");

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid");
    expect(result.message).toContain("千位分隔符");
  });

  it("rejects everything Number() would quietly accept", () => {
    // Number("") is 0, Number("0x10") is 16, Number("1e3") is 1000, Number(" ") is 0.
    // A tally is a decimal figure typed by hand; none of these are one.
    for (const raw of ["abc", "0x10", "1e3", "Infinity", "1.2.3", "+920", "920H", "920 小时"]) {
      expect(parseManualEntry(raw).kind).toBe("invalid");
    }
  });
});

describe("evaluateDraftRow", () => {
  it("reports a blank field as nothing to do", () => {
    expect(evaluateDraftRow(rowOf({ totalHours: 865 }), "")).toEqual({ kind: "blank" });
  });

  it("computes the delta against 当前实绩", () => {
    // 920 against a base of 965 is -45. This single assertion is the one the operator
    // was walked through by hand, and the reason 「已有调整」 is a permanent column.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 865, adjustmentHours: 100 }), "920");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.delta).toBe(-45);
  });

  it("derives a positive delta without the operator typing a sign", () => {
    const verdict = evaluateDraftRow(rowOf({ totalHours: 865 }), "920");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.delta).toBe(55);
  });

  it("writes nothing when the tally already agrees", () => {
    // Filled in but identical - the operator confirmed the number. Confirmation is
    // not an adjustment, and the repository rejects hours === 0 anyway.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 865 }), "865");

    expect(verdict).toEqual({ kind: "unchanged", delta: 0 });
  });

  it("passes an invalid entry straight through", () => {
    expect(evaluateDraftRow(rowOf({ totalHours: 865 }), "abc").kind).toBe("invalid");
  });

  it("rounds float residue away instead of writing a ghost slip", () => {
    // 3000.3 - 2900.2 is 100.10000000000036 in IEEE 754. Stored raw it would show as
    // 100.1 everywhere and still be a different number from 100.1 forever.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 2900.2 }), "3000.3");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.delta).toBe(100.1);
  });

  it("treats sub-epsilon residue as no change at all", () => {
    // A base of 0.1 + 0.2 against a tally of 0.3 differs by 5.6e-17. Writing that
    // slip would put a permanent △ on the month for a difference that does not exist.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 0.1 + 0.2 }), "0.3");

    expect(verdict.kind).toBe("unchanged");
  });

  it("never produces negative zero", () => {
    // Intl.NumberFormat renders -0 as "-0" since ES2020, so an unnormalised -0
    // reaches the screen as 「-0.0」 - which reads as a tiny reduction, not as nothing.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 0.30000000000000004 }), "0.3");

    expect(verdict.kind).toBe("unchanged");
    if (verdict.kind !== "unchanged") throw new Error("expected unchanged");
    expect(Object.is(verdict.delta, -0)).toBe(false);
  });

  it("flags zeroing a section as high risk", () => {
    // A tally of 0 against a base of 3000 wipes the 課 out. On screen it is one
    // character and looks exactly like a slip of the finger.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 3000 }), "0");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.delta).toBe(-3000);
    expect(verdict.risk).toContain("归零");
  });

  it("flags a swing of half the base or more as high risk", () => {
    const verdict = evaluateDraftRow(rowOf({ totalHours: 1000 }), "400");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.risk).not.toBeNull();
  });

  it("leaves an ordinary correction unflagged", () => {
    // -45 on 965 is under 5%. Flagging routine corrections trains the operator to
    // click through the confirmation without reading it.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 865, adjustmentHours: 100 }), "920");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.risk).toBeNull();
  });

  it("does not flag a first-ever entry against an empty base", () => {
    // If a month's fold never arrived, every one of the 24 rows has base 0 and would
    // be "infinitely" high risk. Twenty-four confirmations is the same as none.
    const verdict = evaluateDraftRow(rowOf({}), "920");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.risk).toBeNull();
  });

  it("warns on a delta off the half-hour grid without blocking it", () => {
    // Nothing in the repo enforces 0.5 steps and the adjustment tests deliberately
    // store -12.5, so this is a smell, not an error. Warn on the DELTA, because that
    // is the figure an auditor reads back later.
    const verdict = evaluateDraftRow(rowOf({ totalHours: 900 }), "920.3");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.warnings.length).toBeGreaterThan(0);
  });

  it("does not warn when the delta lands on the grid", () => {
    const verdict = evaluateDraftRow(rowOf({ totalHours: 900 }), "920.5");

    expect(verdict.kind).toBe("write");
    if (verdict.kind !== "write") throw new Error("expected write");
    expect(verdict.warnings).toEqual([]);
  });
});

describe("planAdjustment", () => {
  const ROWS = buildAdjustDraftRows(
    viewOf([
      actual({ sectionId: "sec-inspect", month: 5, totalHours: 865, adjustmentHours: 100 }),
      actual({ sectionId: "sec-quality", month: 5, totalHours: 700 }),
      actual({ sectionId: "sec-assy", month: 5, totalHours: 3000 }),
    ]),
    5,
  );

  it("writes only the rows that actually differ", () => {
    // 只写有差额的行. Blank stays blank; a confirmed-identical figure is not a slip.
    const plan = planAdjustment(
      ROWS,
      new Map([
        ["sec-inspect", "920"],
        ["sec-quality", "700"],
        ["sec-assy", ""],
      ]),
    );

    expect(plan.writes.map((write) => write.sectionId)).toEqual(["sec-inspect"]);
    expect(plan.writes[0]?.hours).toBe(-45);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.blankCount).toBe(1);
  });

  it("counts a row with no entry at all as blank", () => {
    // The form may omit an untouched field entirely rather than post an empty string.
    const plan = planAdjustment(ROWS, new Map([["sec-inspect", "920"]]));

    expect(plan.writes).toHaveLength(1);
    expect(plan.blankCount).toBe(2);
  });

  it("produces an empty plan when nothing was filled in", () => {
    const plan = planAdjustment(ROWS, new Map());

    expect(plan.writes).toEqual([]);
    expect(plan.blankCount).toBe(3);
    expect(plan.risky).toEqual([]);
  });

  it("collects invalid entries with the section name attached", () => {
    // "第 2 行格式错误" is unusable on a 24-row sheet; the operator needs the 課名.
    const plan = planAdjustment(ROWS, new Map([["sec-quality", "abc"]]));

    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0]?.sectionName).toBe("品质课");
  });

  it("still reports the writable rows alongside the invalid ones", () => {
    // The action rejects the whole batch when anything is invalid, but the screen
    // shows what would have been written so the operator can see the damage.
    const plan = planAdjustment(
      ROWS,
      new Map([
        ["sec-inspect", "920"],
        ["sec-quality", "abc"],
      ]),
    );

    expect(plan.invalid).toHaveLength(1);
    expect(plan.writes).toHaveLength(1);
  });

  it("reports a section id that is not on the sheet", () => {
    // A forged or stale sectionId must be named, never silently dropped - dropping it
    // would report success for a write that never happened.
    const plan = planAdjustment(ROWS, new Map([["sec-ghost", "920"]]));

    expect(plan.unknownSectionIds).toEqual(["sec-ghost"]);
    expect(plan.writes).toEqual([]);
  });

  it("lists the high-risk rows for a single batch-level confirmation", () => {
    // One confirmation naming the risky 課, not 24 checkboxes. Per-row gating on a
    // month whose fold is missing degenerates into noise.
    const plan = planAdjustment(
      ROWS,
      new Map([
        ["sec-inspect", "920"],
        ["sec-assy", "0"],
      ]),
    );

    expect(plan.risky.map((entry) => entry.sectionName)).toEqual(["组装课"]);
    expect(plan.writes).toHaveLength(2);
  });

  it("keeps the writes in sheet order", () => {
    // The confirmation dialog and the sheet have to read in the same order, or the
    // operator checks the wrong line.
    const plan = planAdjustment(
      ROWS,
      new Map([
        ["sec-assy", "2900"],
        ["sec-inspect", "920"],
      ]),
    );

    expect(plan.writes.map((write) => write.sectionId)).toEqual(["sec-inspect", "sec-assy"]);
  });
});

describe("findBaseMismatches", () => {
  const ROWS = buildAdjustDraftRows(
    viewOf([
      actual({ sectionId: "sec-inspect", month: 5, totalHours: 865, adjustmentHours: 100 }),
      actual({ sectionId: "sec-quality", month: 5, totalHours: 700 }),
    ]),
    5,
  );

  it("passes when the client saw today's numbers", () => {
    expect(findBaseMismatches(ROWS, new Map([["sec-inspect", 965]]))).toEqual([]);
  });

  it("catches a base that moved while the form was open", () => {
    // The fold reruns at 09:05 and 15:05, and another operator may have filed a slip.
    // Either one changes the base under a sheet that is still on screen, and the
    // delta computed from the stale base is silently wrong by the difference.
    const mismatches = findBaseMismatches(ROWS, new Map([["sec-inspect", 865]]));

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.sectionName).toBe("检查课");
    expect(mismatches[0]?.shown).toBe(865);
    expect(mismatches[0]?.current).toBe(965);
  });

  it("ignores rows the operator is not writing to", () => {
    // Only the submitted rows matter. Drift on an untouched 課 must not block a
    // batch that has nothing to do with it.
    expect(findBaseMismatches(ROWS, new Map([["sec-inspect", 965]]))).toEqual([]);
  });

  it("tolerates display-level rounding", () => {
    // The hidden field carries the raw number, but a tolerance keeps a one-decimal
    // round trip from rejecting an entire batch over 0.001 H.
    expect(findBaseMismatches(ROWS, new Map([["sec-quality", 700.001]]))).toEqual([]);
  });

  it("reports an unknown section rather than skipping it", () => {
    const mismatches = findBaseMismatches(ROWS, new Map([["sec-ghost", 100]]));

    expect(mismatches).toHaveLength(1);
  });
});
