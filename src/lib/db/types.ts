// Plain data-transfer objects for the persistence layer.
//
// Deliberately hand-written interfaces rather than re-exports of the generated
// Prisma types: nothing above `lib/db/` should depend on the ORM's shape, so
// swapping SQLite for PostgreSQL (or Prisma for anything else) stays contained
// inside this directory.

import type { ActualSource } from "./actual-source";

/** A department (部). */
export interface DepartmentDto {
  id: string;
  name: string;
  code: string | null;
  sortOrder: number;
  managerName: string | null;
  managerEmail: string | null;
}

/** A section (課), always owned by exactly one department. */
export interface SectionDto {
  id: string;
  departmentId: string;
  name: string;
  sortOrder: number;
  managerName: string | null;
  managerEmail: string | null;
}

/** A fiscal year running April 1 -> March 31. */
export interface FiscalYearDto {
  id: string;
  name: string;
  year: number;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}

/**
 * The full organisation in one shot, both levels already ordered by
 * (sortOrder, name). Consumed by the org-tree adapter, which relies on this
 * ordering being stable - the dashboard addresses nodes by array index.
 */
export interface OrgSnapshot {
  departments: readonly DepartmentDto[];
  sections: readonly SectionDto[];
}

/** One month of planned/challenge hours for one section. */
export interface PlanRow {
  sectionId: string;
  /**
   * Owning fiscal year. Carried on the read DTO, not just the write input, because
   * (sectionId, month) alone is NOT unique across the table - the composite key is
   * (sectionId, fiscalYearId, month). buildOrgRoot() keys its slots by
   * (sectionId, month) and ASSIGNS rather than accumulates, so a set of rows
   * spanning two fiscal years would have one year silently overwrite the other with
   * no error. This field lets that adapter assert single-year input instead.
   */
  fiscalYearId: string;
  /** 1..12, where 1 = April. */
  month: number;
  plannedHours: number;
  /** Independently entered; may equal or exceed plannedHours. */
  challengeHours: number;
}

/** One month of aggregated actual hours for one section. */
export interface ActualRow {
  sectionId: string;
  /** Owning fiscal year. See PlanRow.fiscalYearId for why the read DTO carries it. */
  fiscalYearId: string;
  /** 1..12, where 1 = April. */
  month: number;
  personnelHours: number;
  /** May be negative (deductions can exceed additions). */
  overtimeHours: number;
  totalHours: number;
  /**
   * How the figure was produced (D-198): `"fold"` from attendance detail, `"manual"`
   * typed in by hand for a month that predates go-live.
   *
   * Carried on the read DTO because it changes what the OTHER columns mean, not just
   * where they came from: a manual row holds the whole month in `totalHours` with
   * `personnelHours` and `overtimeHours` at 0, since the 人员/加班 split comes from
   * per-employee columns that do not exist for those months. Without this field the
   * screen shows two real zeros next to a real total and no way to tell that apart
   * from a section that genuinely logged no overtime.
   */
  source: ActualSource;
}

/**
 * One adjustment slip (D-233): hours that belong in a section-month's 实绩 but have no
 * attendance detail behind them.
 *
 * Carries `id` unlike ActualRow, which is keyed by (sectionId, fiscalYearId, month):
 * there is deliberately no unique key here, so a slip can only be revoked by identity.
 */
export interface ActualAdjustmentRow {
  id: string;
  sectionId: string;
  fiscalYearId: string;
  /** 1..12, where 1 = April. */
  month: number;
  /**
   * Signed. A hand tally BELOW the folded figure is corrected by a negative slip - the
   * same operation as a positive one, so neither direction is a special case.
   */
  hours: number;
  /** Never empty; enforced at the write boundary, not merely by NOT NULL. */
  reason: string;
  /**
   * The section-month's folded `totalHours` when this slip was written; 0 when no actual
   * row existed yet.
   *
   * Null means NOT RECORDED, never "unchanged" - the drift check skips such slips rather
   * than assuming the base held still. Only a write outside the repo (hand-written SQL)
   * can produce null.
   */
  foldHoursAtEntry: number | null;
  /** Always "admin" - a placeholder, not an identity (D-142). */
  changedBy: string;
  changedAt: Date;
  /** Set when revoked; a revoked slip stays stored and stops counting. */
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** Write payload for one adjustment slip. `changedBy`/`changedAt` are defaulted by the DB. */
export interface ActualAdjustmentInput {
  sectionId: string;
  fiscalYearId: string;
  month: number;
  hours: number;
  reason: string;
}

/**
 * An actual row with its adjustments folded in (D-233).
 *
 * DELIBERATELY A SUPERSET of ActualRow rather than a replacement. Every existing
 * consumer reads `totalHours` and keeps compiling unchanged when a query starts
 * returning this type, so the read-side rollout is additive instead of a breaking
 * signature change across the dashboard, the adapter and the 实绩 screen at once.
 *
 * `totalHours` KEEPS ITS MEANING: the folded figure, still equal to
 * personnelHours + overtimeHours. It is not blended with the adjustment. The cost of
 * that choice is that a read point nobody migrated shows an UNDERSTATED number - chosen
 * on purpose, because understated-and-noticeable beats plausible-and-wrong.
 */
export interface ActualEffectiveRow extends ActualRow {
  /** Sum of un-revoked slips for this section-month. 0 when there are none. */
  adjustmentHours: number;
  /** totalHours + adjustmentHours. This is what D-141's 实绩 now means. */
  effectiveHours: number;
  /**
   * True when at least one un-revoked slip on this section-month recorded a folded base
   * that no longer matches `totalHours`.
   *
   * MEANS "SUSPECT", NOT "WRONG". The slip was entered against a different折算值, so its
   * hours may now be double-counting detail that has since arrived - or the base may have
   * moved for an unrelated and perfectly fine reason. Only a human reading the slip's
   * reason can tell, which is why this raises a warning on the 实绩 screen and never
   * silently drops or rescales the adjustment.
   *
   * Always false while no slip carries a recorded base, so it costs nothing until it fires.
   */
  foldChangedSinceAdjustment: boolean;
}

/** Working-day classification. Mirrors the strings stored in work_calendar.day_type. */
export type DayType = "工作日" | "周末" | "节假日" | "年例休";

export interface WorkCalendarDto {
  date: Date;
  dayType: DayType;
  remark: string | null;
}

export interface JobTitleRuleDto {
  jobTitle: string;
  excludePersonnelHours: boolean;
  excludeOvertimeHours: boolean;
  remark: string | null;
}

/**
 * One HR-export spelling of a (部, 課) pair and the Section it resolves to.
 *
 * Needed because the attendance export and the org master do not always spell a
 * section identically - 检查课 (查 U+67E5) vs 检査课 (査 U+67FB) are visually the
 * same and never string-equal. Both `hrDeptName` and `hrSectionName` are stored
 * exactly as exported, byte for byte; normalising them here would defeat the point.
 */
export interface SectionAliasDto {
  id: string;
  hrDeptName: string;
  hrSectionName: string;
  sectionId: string;
  remark: string | null;
}

/**
 * Outcome of one fetch-and-import attempt (D-123).
 *
 * SQLite has no enum, so `status` and `triggeredBy` are plain strings in the table and
 * the vocabulary is enforced in the repository instead - see IMPORT_STATUSES /
 * IMPORT_TRIGGERS in ./import-log.repo. Typing them as unions here means a typo is a
 * compile error at every call site rather than a fourth silent state in the table.
 */
export type ImportStatus = "SUCCESS" | "FAILED" | "PARTIAL";

/** What started an import attempt (D-121: the 06:00 run, an operator, or an hourly retry). */
export type ImportTrigger = "schedule" | "manual" | "retry";

/** One row of `import_log`, as read back for the /actuals status panel. */
export interface ImportLogDto {
  id: string;
  fileName: string;
  /**
   * Source mtime. Null when the file could not be stat'ed at all, which is how
   * "HR has not published today's file yet" stays distinguishable from "the file is
   * there but unreadable" (the D-124 banner quotes the stored message to say which).
   */
  fileMtime: Date | null;
  importedAt: Date;
  status: ImportStatus;
  /** Rows actually written. 0 on FAILED. */
  rowCount: number;
  errorMessage: string | null;
  /**
   * D-222 completeness warning: the rows are valid but the day looks incomplete, most
   * likely exported before HR's clock data finished syncing. Independent of
   * `errorMessage`, which stays null on a clean SUCCESS.
   */
  warningMessage: string | null;
  /**
   * Measured share of unexplained zero-hour rows, 0..1. Null when the export lacked the
   * columns to measure it, held no rows, or the import failed.
   */
  unexplainedZeroRatio: number | null;
  /**
   * D-229: rows this import marked superseded, i.e. rows HR deleted since the earlier
   * fetch of the same day. 0 on FAILED, and also 0 when the sharp-drop guard suppressed
   * supersede - so 0 does not prove nothing was removed; read `errorMessage` too.
   */
  supersededCount: number;
  triggeredBy: ImportTrigger;
}

// ---------------------------------------------------------------------------
// Write inputs
// ---------------------------------------------------------------------------

export interface DepartmentUpsertInput {
  name: string;
  sortOrder: number;
  code?: string | null;
  managerName?: string | null;
  managerEmail?: string | null;
}

export type DepartmentPatch = Partial<Omit<DepartmentUpsertInput, "name">>;

export interface SectionUpsertInput {
  departmentId: string;
  name: string;
  sortOrder: number;
  managerName?: string | null;
  managerEmail?: string | null;
}

export type SectionPatch = Partial<Omit<SectionUpsertInput, "departmentId" | "name">>;

export interface FiscalYearUpsertInput {
  name: string;
  year: number;
  /**
   * Calendar day at UTC midnight - NOT an instant. `upsertFiscalYear()` rejects a
   * value carrying a time component instead of truncating it; convert with
   * businessDayOf() if you are holding a `new Date()`.
   */
  startDate: Date;
  /** Calendar day at UTC midnight. See startDate. */
  endDate: Date;
  isCurrent?: boolean;
}

export interface PlanUpsertInput {
  sectionId: string;
  fiscalYearId: string;
  /** 1..12, where 1 = April. Validated by assertFiscalMonth(). */
  month: number;
  plannedHours: number;
  challengeHours: number;
  updatedBy?: string;
}

/**
 * Which of a plan row's two quantities an audit entry describes.
 *
 * Snake_case on purpose: these are the literal strings stored in
 * `plan_change_log.field`, not the camelCase DTO property names. Keeping them
 * distinct is a small tax that pays off when reading raw SQL against the table.
 */
export type PlanChangeField = "planned_hours" | "challenge_hours";

/**
 * One audit entry: a single field of a single plan row moved from one value to
 * another (D-143 - plan edits are allowed but must leave a trail).
 *
 * One entry per FIELD, not per row. Editing both quantities of one cell produces
 * two entries, so "when did the challenge target change?" is answerable without
 * diffing two-field snapshots.
 *
 * `changedAt` is absent by design - it is the database default so every entry is
 * stamped by one clock, and a caller cannot backdate the trail it is required to
 * leave.
 */
export interface PlanChangeLogInput {
  planId: string;
  field: PlanChangeField;
  beforeValue: number;
  afterValue: number;
  /** Free-text justification. Optional per D-143; blank is normalised to null. */
  reason?: string | null;
  changedBy: string;
}

/** Outcome of an audited plan write. See upsertPlanWithAudit(). */
export interface PlanWriteResult {
  planId: string;
  /** True when the row did not exist. A first insert is not an edit, so it logs nothing. */
  created: boolean;
  /** Audit entries appended - 0 when the submitted values matched the stored ones. */
  loggedChanges: number;
}

export interface ActualUpsertInput {
  sectionId: string;
  fiscalYearId: string;
  /** 1..12, where 1 = April. Validated by assertFiscalMonth(). */
  month: number;
  personnelHours: number;
  overtimeHours: number;
  /** Omit to have it computed as personnelHours + overtimeHours. */
  totalHours?: number;
  sourceFile?: string | null;
  fetchedAt?: Date | null;
}

export interface WorkCalendarUpsertInput {
  date: Date;
  dayType: DayType;
  remark?: string | null;
}

/**
 * Write input for a section alias. Keyed on (hrDeptName, hrSectionName): the HR-side
 * spelling is the natural key, so re-seeding is idempotent and re-pointing an alias at
 * a different Section is an update rather than a duplicate.
 */
export interface SectionAliasUpsertInput {
  hrDeptName: string;
  hrSectionName: string;
  sectionId: string;
  remark?: string | null;
}

/**
 * Write input for one import-log entry.
 *
 * `importedAt` is absent by design - it is the database default, for the same reason as
 * PlanChangeLogInput.changedAt: every entry is stamped by one clock and a caller cannot
 * backdate the audit trail it is required to leave.
 */
export interface ImportLogInput {
  fileName: string;
  /** Null when the file could not be stat'ed - see ImportLogDto.fileMtime. */
  fileMtime?: Date | null;
  status: ImportStatus;
  /** Rows actually written. Must be 0 when status is "FAILED". */
  rowCount?: number;
  /** Failure summary. Required in practice on FAILED/PARTIAL; blank normalises to null. */
  errorMessage?: string | null;
  /** D-222 completeness warning; blank normalises to null. Never set on FAILED. */
  warningMessage?: string | null;
  /** Measured unexplained-zero ratio, 0..1, recorded even when no warning fired. */
  unexplainedZeroRatio?: number | null;
  /**
   * D-229: rows this import superseded. Must be 0 when status is "FAILED" - the write
   * runs in one transaction, so a failure rolled the supersede back too.
   */
  supersededCount?: number;
  triggeredBy: ImportTrigger;
}
