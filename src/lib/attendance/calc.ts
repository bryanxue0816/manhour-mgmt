// Attendance formulas, job-title exclusions and the section x month fold.
//
// PURE. No Prisma, no filesystem, no `.xls`. Everything this module needs arrives as
// plain data, which is what makes the D-110 worked examples testable as five object
// literals instead of five spreadsheet fixtures.
//
// It sits between two impure neighbours:
//   * attendance/parser.ts answers "what does the file say" (raw column values);
//   * db/attendance.repo.ts answers "what is stored" (upsert + recompute).
// This module answers "what do the numbers mean", and it is the only place the D-104 /
// D-105 / D-106 arithmetic and the D-107..D-109 exclusion verdicts exist.
//
// RECOMPUTED FROM INPUTS, NEVER FROM STORED TOTALS. Both entry points take the ten raw
// hour columns, not `AttendanceRaw.personnelHours`. D-161 is the proof this matters: the
// exclusion lists grew AFTER the first import, and folding stored post-exclusion figures
// would have required re-fetching the month from HR to apply the new rules. Feeding the
// inputs back through the same functions rebuilds Actual from the database alone.
//
// EXCLUSION MEANS ZERO, NOT SKIP (D-107/D-108). An excluded row still exists, still
// resolves to a section, and still carries its inputs; only its contribution to the
// aggregate is dropped. That distinction is load-bearing in both directions: the row
// stays auditable, and the `excluded*` flags stay reportable.
//
// NOTHING IS CLAMPED. D-105 overtime is legitimately negative - a day spent on
// compensatory leave contributes -8 - and the measured file has 8 such rows. A
// `Math.max(0, ...)` would silently convert a real deduction into a real error, and
// because the exclusion set contains 课长 (whose rows aggregate to -8), removing rows can
// RAISE the overtime total. Any check that assumes exclusions only ever reduce a figure
// is wrong; the measured day goes 342.5 -> 350.5.

import { assertCalendarDay, fiscalMonthOf, fiscalYearOf } from "@/lib/db/date";
import { assertFiniteHours } from "@/lib/db/hours";
import { aliasKey } from "@/lib/db/section-key";
import type { JobTitleRuleDto, OrgSnapshot } from "@/lib/db/types";

/**
 * The ten formula input columns, exactly as the HR export spells them.
 *
 * Declared as its own interface so a stored `AttendanceRaw` row and a freshly parsed
 * `ParsedAttendanceRow` are both accepted without either module importing the other.
 */
export interface AttendanceHourInputs {
  /** R 请假时间 (D-104). */
  leaveHours: number;
  /** S 上班时数 (D-104). */
  workHours: number;
  /** Z 平时加班 (D-105, additive). */
  normalOvertime: number;
  /** AA 休日双倍 (D-105, additive). */
  restDayDouble: number;
  /** AB 节假加班 (D-105, additive). */
  holidayOvertime: number;
  /** AD 休日调休 (D-105, additive). */
  restDayCompensate: number;
  /** AF 调休假时数 (D-105, subtractive). */
  compensatoryLeave: number;
  /** AV 产假时数 (D-105, subtractive). */
  maternityLeave: number;
  /** AY 护理假时数 (D-105, subtractive). */
  nursingLeave: number;
  /** BA 流产假时数 (D-105, subtractive). */
  miscarriageLeave: number;
}

/**
 * One attendance row reduced to the fields the calculation actually reads.
 *
 * Deliberately excludes 工号 / 姓名 / 员工类别: none of them influences a number, and
 * leaving them out means a unit test states only what the assertion depends on. The
 * import path zips the results back onto the full rows by index.
 */
export interface AttendanceFacts extends AttendanceHourInputs {
  /** Calendar day at UTC midnight - see lib/db/date.ts#assertCalendarDay. */
  workDate: Date;
  /** 部别 verbatim, including "" and HR's literal "（空）" placeholder. */
  hrDeptName: string;
  /** 课别 verbatim; null for the 35 measured rows that carry none. */
  hrSectionName: string | null;
  /** 职务; null rows can match no rule and are therefore never excluded. */
  jobTitle: string | null;
}

/** Which of the two hour figures this row's job title removes from the aggregate. */
export interface ExclusionVerdict {
  /** D-107, as revised by D-238: 部长 / 项目课长 / 副总经理, plus anything an admin adds. */
  excludedPersonnel: boolean;
  /** D-108: currently every seeded title, i.e. the D-107 set plus 项目部长 / 工场长 / 高级课长 / 课长 / 项目经理. */
  excludedOvertime: boolean;
}

/** D-104 / D-105 / D-106 applied to one row, BEFORE any exclusion. */
export interface AttendanceRowHours {
  personnelHours: number;
  overtimeHours: number;
  totalHours: number;
}

/** One row's pre-exclusion figures, verdict, and resolved section. */
export interface ComputedAttendanceRow extends AttendanceRowHours, ExclusionVerdict {
  /** Resolved Section, or null when neither an exact match nor an alias applies. */
  sectionId: string | null;
  /** 1..12, 1 = April. */
  month: number;
  /** Fiscal year the day belongs to; the year the fiscal year STARTS in. */
  fiscalYear: number;
}

/** Everything the fold needs from the database, loaded once per import. */
export interface AttendanceCalcContext {
  /** `部|課` -> sectionId, exact spellings from the org master. */
  sectionIndex: ReadonlyMap<string, string>;
  /** `部|課` -> sectionId, HR-side spellings from SectionAlias. */
  aliasIndex: ReadonlyMap<string, string>;
  /** 职务 -> rule. A title absent from the map is NOT excluded (see ruleVerdict). */
  ruleIndex: ReadonlyMap<string, JobTitleRuleDto>;
}

/** One (section, fiscal year, month) bucket, POST-exclusion - an `Actual` row. */
export interface ActualAggregate {
  sectionId: string;
  fiscalYear: number;
  month: number;
  personnelHours: number;
  overtimeHours: number;
  totalHours: number;
}

/** Hours that resolved to no section, grouped by the HR spelling that failed. */
export interface UnattributedGroup {
  hrDeptName: string;
  hrSectionName: string | null;
  rowCount: number;
  /** POST-exclusion total, so the banner figure and the aggregate use one rule. */
  totalHours: number;
}

/** Result of folding a set of rows: what to write, and what could not be written. */
export interface AggregatedAttendance {
  /** Ordered by (sectionId, fiscalYear, month) for reproducible diffs and fixtures. */
  aggregates: readonly ActualAggregate[];
  /** Ordered by (部, 課); descending row count would hide new spellings. */
  unattributed: readonly UnattributedGroup[];
  /** Row count behind `unattributed` - measured at 35 for one real day. */
  unattributedRows: number;
  /** Hour total behind `unattributed` - measured at 231 for one real day. */
  unattributedHours: number;
}

/**
 * D-104: 人员工时 = R(请假时间) + S(上班时数).
 *
 * Leave counts as attendance on purpose - HR confirmed on 2026-08-01 that R + S already
 * nets out 出勤停止 and 无薪上班, so no further deduction belongs here.
 */
export function personnelHoursOf(inputs: AttendanceHourInputs): number {
  return inputs.leaveHours + inputs.workHours;
}

/**
 * D-105: 加班工时 = Z + AA + AB + AD - AF - AV - AY - BA.
 *
 * NOT the export's own 加班总时数 (AC) or 实际出勤加班时数 (AH). Those two columns sit
 * beside these inputs, carry similar names and compute something else; D-105 flags the
 * collision explicitly and the parser deliberately does not even map them.
 *
 * A negative result is the intended answer, not an error - see the module note.
 */
export function overtimeHoursOf(inputs: AttendanceHourInputs): number {
  const added =
    inputs.normalOvertime +
    inputs.restDayDouble +
    inputs.holidayOvertime +
    inputs.restDayCompensate;
  const deducted =
    inputs.compensatoryLeave +
    inputs.maternityLeave +
    inputs.nursingLeave +
    inputs.miscarriageLeave;
  return added - deducted;
}

/**
 * D-104 / D-105 / D-106 for one row, pre-exclusion.
 *
 * Each figure passes assertFiniteHours(): a NaN or Infinity here is accepted by SQLite's
 * `REAL NOT NULL`, survives the read, and then poisons every roll-up that touches the
 * section - while `JSON.stringify` renders it as `null`, so the poisoned row looks empty
 * in a log. See lib/db/hours.ts.
 *
 * @throws if any derived figure is not finite.
 */
export function rowHoursOf(inputs: AttendanceHourInputs): AttendanceRowHours {
  const personnelHours = personnelHoursOf(inputs);
  const overtimeHours = overtimeHoursOf(inputs);
  const totalHours = personnelHours + overtimeHours;
  assertFiniteHours("personnelHours", personnelHours);
  assertFiniteHours("overtimeHours", overtimeHours);
  assertFiniteHours("totalHours", totalHours);
  return { personnelHours, overtimeHours, totalHours };
}

/**
 * The exclusion verdict for one 职务 (D-109).
 *
 * A missing rule means BOTH flags false, and that is the common case rather than an
 * anomaly: only titles that need excluding are seeded, so 主管 / 司机 / 项目经理 and most
 * of the 18 measured titles have no row at all. Treating a miss as an error would reject
 * the majority of a normal import; treating it as "excluded" would zero the plant.
 *
 * A null 职务 matches nothing and is therefore never excluded - the safe direction, since
 * an unnamed title cannot be shown to be managerial.
 */
export function ruleVerdict(
  jobTitle: string | null,
  ruleIndex: ReadonlyMap<string, JobTitleRuleDto>,
): ExclusionVerdict {
  if (jobTitle === null) {
    return { excludedPersonnel: false, excludedOvertime: false };
  }
  const rule = ruleIndex.get(jobTitle);
  if (rule === undefined) {
    return { excludedPersonnel: false, excludedOvertime: false };
  }
  return {
    excludedPersonnel: rule.excludePersonnelHours,
    excludedOvertime: rule.excludeOvertimeHours,
  };
}

/**
 * What one row contributes to its section's aggregate: pre-exclusion hours with the
 * excluded halves zeroed.
 *
 * This is the shape the D-110 worked examples assert on - 薛平 8/0/8, 胡正 8/0/8,
 * 陈勇 8/-8/0, 孙娟 0/0/0, 吕燕芳 8/0/8.
 *
 * `totalHours` is recomputed from the two surviving halves rather than carried over.
 * Zeroing a half and keeping the old sum is the bug this guards against: 孙娟 would
 * report 0 personnel, 0 overtime and 8.5 total.
 */
export function contributionOf(
  hours: AttendanceRowHours,
  verdict: ExclusionVerdict,
): AttendanceRowHours {
  const personnelHours = verdict.excludedPersonnel ? 0 : hours.personnelHours;
  const overtimeHours = verdict.excludedOvertime ? 0 : hours.overtimeHours;
  return { personnelHours, overtimeHours, totalHours: personnelHours + overtimeHours };
}

/**
 * `部|課` -> sectionId for every section in the org master.
 *
 * Sections are keyed by (部门名, 课名) rather than by id because that pair is what the
 * attendance export carries. A section whose department is missing is skipped: it cannot
 * be addressed by name at all, and the schema's Restrict relation makes it unreachable.
 */
export function buildSectionIndex(snapshot: OrgSnapshot): Map<string, string> {
  const deptNameById = new Map(snapshot.departments.map((d) => [d.id, d.name]));
  const index = new Map<string, string>();
  for (const section of snapshot.sections) {
    const deptName = deptNameById.get(section.departmentId);
    if (deptName === undefined) {
      continue;
    }
    index.set(aliasKey(deptName, section.name), section.id);
  }
  return index;
}

/** 职务 -> rule, for ruleVerdict(). */
export function buildRuleIndex(
  rules: readonly JobTitleRuleDto[],
): Map<string, JobTitleRuleDto> {
  return new Map(rules.map((rule) => [rule.jobTitle, rule]));
}

/**
 * Resolves an HR (部别, 课别) pair to a Section: exact match first, then SectionAlias.
 *
 * Comparison is VERBATIM on both paths - no trim, no NFKC, no width folding. The whole
 * reason the alias table exists is that 检查课 (查 U+67E5) and 检査课 (査 U+67FB) render
 * identically and are never string-equal; NFKC would fold exactly the distinctions this
 * lookup is built to preserve. 25 measured rows a day depend on the alias hit.
 *
 * A null 课别 is looked up as `部|` rather than short-circuited to null. Those 35 rows
 * (支援人员 and department-level managers) are unattributed TODAY, but an administrator
 * who decides 「DMHZ支援人员」 belongs to a section must be able to say so with an alias
 * instead of a code change.
 *
 * @returns the sectionId, or null when the pair matches nothing. Null is a warning
 *   (未归属工时), never a reason to reject the import - see 「默认全额计入 + 未归属可见告警」.
 */
export function resolveSectionId(
  facts: Pick<AttendanceFacts, "hrDeptName" | "hrSectionName">,
  context: Pick<AttendanceCalcContext, "sectionIndex" | "aliasIndex">,
): string | null {
  const key = aliasKey(facts.hrDeptName, facts.hrSectionName ?? "");
  return context.sectionIndex.get(key) ?? context.aliasIndex.get(key) ?? null;
}

/**
 * Computes one row end to end: hours, verdict, section, fiscal month.
 *
 * @throws if `workDate` is not a calendar day at UTC midnight. Not defensive padding:
 *   an instant taken from a UTC+8 host between 00:00 and 08:00 has a UTC date one day
 *   earlier, which on 1 April files the new year's first shift into the previous fiscal
 *   year's March with no error anywhere.
 * @throws if any derived hour figure is not finite - see rowHoursOf().
 */
export function computeAttendanceRow(
  facts: AttendanceFacts,
  context: AttendanceCalcContext,
): ComputedAttendanceRow {
  assertCalendarDay(facts.workDate);
  const hours = rowHoursOf(facts);
  const verdict = ruleVerdict(facts.jobTitle, context.ruleIndex);
  return {
    ...hours,
    ...verdict,
    sectionId: resolveSectionId(facts, context),
    month: fiscalMonthOf(facts.workDate),
    fiscalYear: fiscalYearOf(facts.workDate),
  };
}

/**
 * Computes every row, INDEX-PARALLEL to the input.
 *
 * The result deliberately does not embed the source row. The import path needs to write
 * 工号 / 姓名 / 员工类别 alongside these figures and zips the two arrays by index;
 * carrying the row through would force this module's types to depend on the parser's.
 */
export function computeAttendanceRows(
  facts: readonly AttendanceFacts[],
  context: AttendanceCalcContext,
): ComputedAttendanceRow[] {
  return facts.map((row) => computeAttendanceRow(row, context));
}

/** Mutable accumulator behind one `aggregates` entry. */
type AggregateBucket = ActualAggregate;

/** Mutable accumulator behind one `unattributed` entry. */
type UnattributedBucket = UnattributedGroup;

/**
 * Folds computed rows into (section, fiscal year, month) buckets (D-111).
 *
 * Rows are ACCUMULATED, so this is only correct over a complete month. The import path
 * therefore re-reads every stored row of each affected month rather than adding the day
 * just uploaded onto whatever `Actual` already held - re-importing a corrected day
 * (D-122 permits it) would otherwise double-count it.
 *
 * Unattributed rows (`sectionId === null`) are folded into a SEPARATE bucket, not
 * dropped and not forced into an arbitrary section. They stay imported in full and
 * surface as the /actuals warning banner; the measured day yields 231 hours over 35 rows
 * across 8 distinct HR spellings.
 *
 * Both buckets use POST-exclusion figures, so the banner total and the section totals
 * are expressed in the same units and can be added to each other.
 */
export function aggregateAttendance(
  computed: readonly ComputedAttendanceRow[],
  facts: readonly AttendanceFacts[],
): AggregatedAttendance {
  if (computed.length !== facts.length) {
    throw new Error(
      `aggregateAttendance: computed/facts length mismatch ` +
        `(${computed.length} vs ${facts.length}); the arrays must be index-parallel`,
    );
  }

  const buckets = new Map<string, AggregateBucket>();
  const unattributed = new Map<string, UnattributedBucket>();
  let unattributedRows = 0;
  let unattributedHours = 0;

  for (const [index, row] of computed.entries()) {
    const fact = facts[index];
    if (fact === undefined) {
      // Unreachable given the length check above; kept because a silent skip here would
      // under-report a section's hours with no error anywhere.
      throw new Error(`aggregateAttendance: missing facts at index ${index}`);
    }
    const contribution = contributionOf(row, row);

    if (row.sectionId === null) {
      const key = aliasKey(fact.hrDeptName, fact.hrSectionName ?? "");
      const bucket = unattributed.get(key);
      if (bucket === undefined) {
        unattributed.set(key, {
          hrDeptName: fact.hrDeptName,
          hrSectionName: fact.hrSectionName,
          rowCount: 1,
          totalHours: contribution.totalHours,
        });
      } else {
        bucket.rowCount += 1;
        bucket.totalHours += contribution.totalHours;
      }
      unattributedRows += 1;
      unattributedHours += contribution.totalHours;
      continue;
    }

    const key = `${row.sectionId}|${String(row.fiscalYear)}|${String(row.month)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        sectionId: row.sectionId,
        fiscalYear: row.fiscalYear,
        month: row.month,
        personnelHours: contribution.personnelHours,
        overtimeHours: contribution.overtimeHours,
        totalHours: contribution.totalHours,
      });
    } else {
      bucket.personnelHours += contribution.personnelHours;
      bucket.overtimeHours += contribution.overtimeHours;
      bucket.totalHours += contribution.totalHours;
    }
  }

  // Validated after folding, not per row: two finite operands can still sum past the
  // double range, and `totalHours` is the column the dashboard actually reads.
  const aggregates = [...buckets.values()].sort(compareAggregates);
  for (const bucket of aggregates) {
    assertFiniteHours("personnelHours", bucket.personnelHours);
    assertFiniteHours("overtimeHours", bucket.overtimeHours);
    assertFiniteHours("totalHours", bucket.totalHours);
  }
  assertFiniteHours("unattributedHours", unattributedHours);

  return {
    aggregates,
    unattributed: [...unattributed.values()].sort(compareUnattributed),
    unattributedRows,
    unattributedHours,
  };
}

/** (sectionId, fiscalYear, month) ascending. */
function compareAggregates(a: ActualAggregate, b: ActualAggregate): number {
  if (a.sectionId !== b.sectionId) {
    return a.sectionId < b.sectionId ? -1 : 1;
  }
  if (a.fiscalYear !== b.fiscalYear) {
    return a.fiscalYear - b.fiscalYear;
  }
  return a.month - b.month;
}

/** (部, 課) ascending, with a null 课别 sorting before any named one. */
function compareUnattributed(a: UnattributedGroup, b: UnattributedGroup): number {
  if (a.hrDeptName !== b.hrDeptName) {
    return a.hrDeptName < b.hrDeptName ? -1 : 1;
  }
  const left = a.hrSectionName ?? "";
  const right = b.hrSectionName ?? "";
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
