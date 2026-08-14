// Server Actions for the master-data admin page (Phase 5 task 4).
//
// Write surfaces: job-title rules (D-109/D-156), the editable columns of the
// department / section tree, and section rename (D-179). Every one follows the two
// boundary rules established by src/app/plans/actions.ts:
//
//   1. Actions take RAW STRINGS, never numbers. `sortOrder` arrives as whatever the
//      administrator typed, so "1.5" and "abc" can be reported differently instead of
//      both collapsing into NaN in the browser.
//
//   2. Actions RETURN failures instead of throwing them. A thrown Server Action
//      reaches the client as an opaque digest in production, which would reduce a
//      recoverable "该职位已有规则" into "something went wrong".
//
// Server Actions are public HTTP endpoints - the browser is not a trust boundary - so
// payload shape is validated here rather than trusted from the TypeScript types.
//
// SCOPE:
//
//   - Section rename is supported, and ONLY through renameSectionWithAlias(): the
//     rename and the SectionAlias that keeps historical attendance attached share one
//     transaction. `SectionPatch` still excludes `name` so no other path can rename a
//     row without that alias - see the repo function for why a bare rename loses
//     history silently.
//
//   - Department rename is NOT supported. buildSectionIndex() keys sections on
//     aliasKey(部名, 课名), so the department name is part of every section's lookup
//     key: renaming one department breaks the historical match for ALL of its sections
//     at once, and compensating needs one alias per section rather than one. Its own
//     piece of work, by blast radius.
//
//   - Re-running `npm run db:seed` after a rename WILL re-create the old spelling as a
//     second section: the seed hardcodes the original name and writes through
//     upsertSection() on the natural key (departmentId, name). No alias can prevent
//     that, because the seed's write is legitimate on its own terms. There is no org
//     Excel import route in the app - the seed is the only re-import path - so the
//     mitigation is to update prisma/seed.ts when a rename is meant to be permanent.
//
//   - No deletion. Section is referenced with onDelete: Restrict by Plan, Actual,
//     SectionAlias and AttendanceRaw, so deleting a populated one throws a raw
//     English FK-constraint message. Useful deletion means checking all four and
//     naming each blocker, which is also its own piece of work.

"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/generated/prisma/client";
import { createJobTitleRule, upsertJobTitleRule } from "@/lib/db/job-title-rule.repo";
import {
  SectionRenameError,
  renameSectionWithAlias,
  updateDepartment,
  updateSection,
  upsertSection,
} from "@/lib/db/org.repo";

/** Guards the free-text remark against an unbounded write. */
const REMARK_MAX_LENGTH = 200;

/**
 * Upper bound on `sortOrder`. Not a storage limit - Int holds far more - but a typo
 * guard: sortOrder mirrors Excel row order, so a five-digit value is a mistyped cell
 * rather than an intent. Rejecting it keeps the org list scannable.
 */
const SORT_ORDER_MAX = 9999;

/** Unique-constraint violation. Reported to the user; never logged as a crash. */
const UNIQUE_VIOLATION = "P2002";

/** Row addressed by id does not exist - a stale page, not bad input. */
const RECORD_NOT_FOUND = "P2025";

/**
 * Every action returns this shape.
 *
 * `fieldErrors` non-empty means the input is correctable, so the editor keeps the
 * administrator's draft and marks the offending inputs. Empty means the write itself
 * failed and the editor should revert to the stored values.
 */
export type AdminActionResult<TField extends string = string> =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors: Partial<Record<TField, string>>;
    };

/** Failure-shape helper - keeps the early returns to one line each. */
function reject<TField extends string>(
  message: string,
  fieldErrors: Partial<Record<TField, string>> = {},
): AdminActionResult<TField> {
  return { ok: false, message, fieldErrors };
}

/**
 * Reads a Prisma error code without asserting a type.
 *
 * @returns the code, or null when this is not a known request error. Callers use it to
 *   split "the user typed a duplicate" (P2002, a message) from "something is broken"
 *   (anything else, a log plus a generic message).
 */
function prismaErrorCode(error: unknown): string | null {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
}

/**
 * Trims and length-checks a required single-line text value.
 *
 * @returns the trimmed value, or an `error` message. Trimming happens BEFORE the
 *   empty check so a value of only spaces is rejected rather than stored as "   ",
 *   which would render as a blank row that cannot be clicked.
 */
function parseRequiredText(
  raw: unknown,
  label: string,
  maxLength: number,
): { value: string } | { error: string } {
  if (typeof raw !== "string") {
    return { error: `${label}格式不合法。` };
  }
  const value = raw.trim();
  if (value === "") {
    return { error: `${label}不能为空。` };
  }
  if (value.length > maxLength) {
    return { error: `${label}最长 ${String(maxLength)} 字。` };
  }
  return { value };
}

/**
 * Trims an optional text value into the null / string the DTOs expect.
 *
 * A blank input means "clear this column", which is `null` rather than `""`: the read
 * side renders both as an em dash, but only null keeps the column honest for any
 * future query that filters on IS NULL.
 */
function parseOptionalText(
  raw: unknown,
  label: string,
  maxLength: number,
): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) {
    return { value: null };
  }
  if (typeof raw !== "string") {
    return { error: `${label}格式不合法。` };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { value: null };
  }
  if (trimmed.length > maxLength) {
    return { error: `${label}最长 ${String(maxLength)} 字。` };
  }
  return { value: trimmed };
}

/**
 * Parses an optional manager email, rejecting anything that cannot be delivered to.
 *
 * A separate function rather than a flag on parseOptionalText: 责任者 and 备注 are free
 * text and must stay that way, so the address rule belongs only where an address is
 * meant.
 *
 * Why validate at all, when nothing sends mail today: D-150 makes these columns the
 * recipient source for the D-135 / D-210 alert mails. An address stored without a shape
 * check surfaces as "the alert never fired" months later in v2, not as "this address is
 * wrong" at the moment someone typed it.
 *
 * The shape check is deliberately loose - one @, non-empty on both sides, at least one
 * dot in the domain, no whitespace. A stricter regex would reject legal addresses
 * (quoted local parts, new TLDs) and there is no way to truly validate an address short
 * of sending to it. This catches the realistic typo class: a name with no domain, a
 * missing @, a trailing comma from a pasted list.
 */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseOptionalEmail(
  raw: unknown,
  maxLength: number,
): { value: string | null } | { error: string } {
  const text = parseOptionalText(raw, "邮箱", maxLength);
  if ("error" in text || text.value === null) {
    return text;
  }
  if (!EMAIL_SHAPE.test(text.value)) {
    return { error: "邮箱格式不合法,应形如 name@example.com。" };
  }
  return text;
}

/**
 * Parses the typed sortOrder into a non-negative integer.
 *
 * `Number()` is used rather than `parseInt()` on purpose: parseInt("1.5") returns 1
 * and parseInt("12abc") returns 12, so both would be silently accepted as different
 * numbers than the administrator typed. Number() yields 1.5 and NaN respectively,
 * which the checks below reject with an accurate message.
 *
 * Blank is an error, not 0: 0 is a legal sort position, so reading an empty box as 0
 * would move the row to the top of the list without anyone asking.
 */
function parseSortOrder(raw: unknown): { value: number } | { error: string } {
  if (typeof raw !== "string") {
    return { error: "排序值格式不合法。" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: "排序值未录入。" };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { error: "排序值只能填数字。" };
  }
  if (!Number.isInteger(value)) {
    return { error: "排序值只能填整数。" };
  }
  if (value < 0) {
    return { error: "排序值不能为负数。" };
  }
  if (value > SORT_ORDER_MAX) {
    return { error: `排序值不能超过 ${String(SORT_ORDER_MAX)}。` };
  }
  return { value };
}

/** Validates a boolean flag arriving from the browser. */
function isBoolean(raw: unknown): raw is boolean {
  return typeof raw === "boolean";
}

/**
 * Revalidates /admin after a COMMITTED write.
 *
 * Guarded by its own try and placed outside the write's: by this point the row is
 * stored, so a failure here must never be reported as "未保存" - that would send the
 * administrator to re-enter a value that is already persisted. A stale page is
 * cosmetic and the next navigation fixes it.
 */
function revalidateAdmin(action: string): void {
  try {
    revalidatePath("/admin");
  } catch (error) {
    console.error(`[${action}] revalidatePath failed after a committed write`, error);
  }
}

// ---------------------------------------------------------------------------
// Job-title rules (D-109 / D-156)
// ---------------------------------------------------------------------------

export type JobTitleRuleField = "jobTitle" | "remark";

export interface SaveJobTitleRuleInput {
  /** Exactly what the administrator typed. The @id column, so also the natural key. */
  jobTitleRaw: string;
  excludePersonnelHours: boolean;
  excludeOvertimeHours: boolean;
  remarkRaw?: string | null;
  /**
   * True when the editor is adding a rule rather than editing an existing row.
   *
   * This is the ONLY way to tell the two apart, because the repository exposes an
   * upsert and `jobTitle` is the primary key: an "add" that collides with a stored
   * title would silently overwrite that row's flags. On create the collision is
   * therefore checked and reported; on edit, hitting the same key is the point.
   */
  isCreate: boolean;
}

/**
 * Creates or updates one job-title exclusion rule.
 *
 * Both flags and the remark are always written - see upsertJobTitleRule's docstring:
 * the payload carries complete desired state, which is what makes it possible to turn
 * an exclusion back OFF.
 */
export async function saveJobTitleRule(
  input: SaveJobTitleRuleInput,
): Promise<AdminActionResult<JobTitleRuleField>> {
  const jobTitle = parseRequiredText(input?.jobTitleRaw, "职位名称", 50);
  if ("error" in jobTitle) {
    return reject("请修正标红的输入后重试。", { jobTitle: jobTitle.error });
  }

  const remark = parseOptionalText(input.remarkRaw, "备注", REMARK_MAX_LENGTH);
  if ("error" in remark) {
    return reject("请修正标红的输入后重试。", { remark: remark.error });
  }

  if (!isBoolean(input.excludePersonnelHours) || !isBoolean(input.excludeOvertimeHours)) {
    return reject("排除标记格式不合法,请刷新页面后重试。");
  }
  if (typeof input.isCreate !== "boolean") {
    return reject("请求不完整,请刷新页面后重试。");
  }

  try {
    if (input.isCreate) {
      // createJobTitleRule() rather than the upsert: a duplicate must fail loudly,
      // because jobTitle is the @id and an upsert would overwrite a row already on
      // screen. Prisma reports the PK collision as P2002, caught below.
      await createJobTitleRule({
        jobTitle: jobTitle.value,
        excludePersonnelHours: input.excludePersonnelHours,
        excludeOvertimeHours: input.excludeOvertimeHours,
        remark: remark.value,
      });
    } else {
      await upsertJobTitleRule({
        jobTitle: jobTitle.value,
        excludePersonnelHours: input.excludePersonnelHours,
        excludeOvertimeHours: input.excludeOvertimeHours,
        remark: remark.value,
      });
    }
  } catch (error) {
    if (prismaErrorCode(error) === UNIQUE_VIOLATION) {
      return reject("请修正标红的输入后重试。", {
        jobTitle: `职位「${jobTitle.value}」已有规则,请直接编辑该行。`,
      });
    }
    console.error(`[saveJobTitleRule] failed for jobTitle=${jobTitle.value}`, error);
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAdmin("saveJobTitleRule");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Department (部)
// ---------------------------------------------------------------------------

export type DepartmentField = "code" | "sortOrder" | "managerName" | "managerEmail";

export interface SaveDepartmentInput {
  id: string;
  /** Optional short code. `@unique` when present, so a collision is reportable. */
  codeRaw?: string | null;
  sortOrderRaw: string;
  managerNameRaw?: string | null;
  managerEmailRaw?: string | null;
}

/**
 * Updates one department's editable columns.
 *
 * `name` is absent by design - see the SCOPE note at the top of this file.
 */
export async function saveDepartment(
  input: SaveDepartmentInput,
): Promise<AdminActionResult<DepartmentField>> {
  if (typeof input?.id !== "string" || input.id.trim() === "") {
    return reject("缺少部门标识,请刷新页面后重试。");
  }

  const fieldErrors: Partial<Record<DepartmentField, string>> = {};

  const code = parseOptionalText(input.codeRaw, "部门编码", 20);
  if ("error" in code) {
    fieldErrors.code = code.error;
  }
  const sortOrder = parseSortOrder(input.sortOrderRaw);
  if ("error" in sortOrder) {
    fieldErrors.sortOrder = sortOrder.error;
  }
  const managerName = parseOptionalText(input.managerNameRaw, "责任者", 50);
  if ("error" in managerName) {
    fieldErrors.managerName = managerName.error;
  }
  const managerEmail = parseOptionalEmail(input.managerEmailRaw, 100);
  if ("error" in managerEmail) {
    fieldErrors.managerEmail = managerEmail.error;
  }

  // Collected rather than early-returned one at a time: the row is edited as a whole,
  // so reporting one error per round-trip would make the administrator save four times
  // to find four mistakes.
  if (Object.keys(fieldErrors).length > 0) {
    return reject("请修正标红的输入后重试。", fieldErrors);
  }
  if (
    "error" in code ||
    "error" in sortOrder ||
    "error" in managerName ||
    "error" in managerEmail
  ) {
    // Unreachable: the guard above returns first. Present because `in` narrowing does
    // not survive the assignments, and this reads the values back through the same
    // guard instead of casting.
    return reject("请修正标红的输入后重试。", fieldErrors);
  }

  try {
    await updateDepartment(input.id, {
      code: code.value,
      sortOrder: sortOrder.value,
      managerName: managerName.value,
      managerEmail: managerEmail.value,
    });
  } catch (error) {
    const failed = prismaErrorCode(error);
    if (failed === UNIQUE_VIOLATION) {
      return reject("请修正标红的输入后重试。", {
        code: "该部门编码已被占用,请换一个。",
      });
    }
    if (failed === RECORD_NOT_FOUND) {
      return reject("该部门已不存在,请刷新页面后重试。");
    }
    console.error(`[saveDepartment] failed for id=${input.id}`, error);
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAdmin("saveDepartment");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Section (課)
// ---------------------------------------------------------------------------

export type SectionField = "name" | "sortOrder" | "managerName" | "managerEmail";

export interface SaveSectionInput {
  id: string;
  sortOrderRaw: string;
  managerNameRaw?: string | null;
  managerEmailRaw?: string | null;
}

/** Updates one section's editable columns. Renaming goes through renameSection(). */
export async function saveSection(
  input: SaveSectionInput,
): Promise<AdminActionResult<SectionField>> {
  if (typeof input?.id !== "string" || input.id.trim() === "") {
    return reject("缺少课标识,请刷新页面后重试。");
  }

  const fieldErrors: Partial<Record<SectionField, string>> = {};

  const sortOrder = parseSortOrder(input.sortOrderRaw);
  if ("error" in sortOrder) {
    fieldErrors.sortOrder = sortOrder.error;
  }
  const managerName = parseOptionalText(input.managerNameRaw, "责任者", 50);
  if ("error" in managerName) {
    fieldErrors.managerName = managerName.error;
  }
  const managerEmail = parseOptionalEmail(input.managerEmailRaw, 100);
  if ("error" in managerEmail) {
    fieldErrors.managerEmail = managerEmail.error;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return reject("请修正标红的输入后重试。", fieldErrors);
  }
  if ("error" in sortOrder || "error" in managerName || "error" in managerEmail) {
    return reject("请修正标红的输入后重试。", fieldErrors);
  }

  try {
    await updateSection(input.id, {
      sortOrder: sortOrder.value,
      managerName: managerName.value,
      managerEmail: managerEmail.value,
    });
  } catch (error) {
    if (prismaErrorCode(error) === RECORD_NOT_FOUND) {
      return reject("该课已不存在,请刷新页面后重试。");
    }
    console.error(`[saveSection] failed for id=${input.id}`, error);
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAdmin("saveSection");
  return { ok: true };
}

export interface RenameSectionInput {
  id: string;
  /** New 课 name, exactly as typed. Compared verbatim - no normalisation (aliasKey). */
  nameRaw: string;
}

/**
 * Renames one section, leaving an alias so historical attendance still resolves.
 *
 * Separate from saveSection() rather than another field on it, for two reasons. A
 * rename is not a column edit: it writes a second row (the alias) and can be refused
 * for reasons the other columns cannot produce, so folding it in would make one
 * "保存" mean two different transactions. And the editor asks for confirmation before
 * a rename but not before a sortOrder tweak, which needs two call sites anyway.
 *
 * Renaming to the current name is accepted and writes nothing - see the repository.
 */
export async function renameSection(
  input: RenameSectionInput,
): Promise<AdminActionResult<SectionField>> {
  if (typeof input?.id !== "string" || input.id.trim() === "") {
    return reject("缺少课标识,请刷新页面后重试。");
  }

  const name = parseRequiredText(input.nameRaw, "课名称", 50);
  if ("error" in name) {
    return reject("请修正标红的输入后重试。", { name: name.error });
  }

  try {
    await renameSectionWithAlias(input.id, name.value);
  } catch (error) {
    if (error instanceof SectionRenameError) {
      switch (error.reason) {
        case "not-found":
          return reject("该课已不存在,请刷新页面后重试。");
        case "name-taken":
          return reject("请修正标红的输入后重试。", {
            name: `本部门下已有「${name.value}」,请换一个名称。`,
          });
        case "alias-conflict":
          // Not overwritten on purpose: that alias is someone's deliberate mapping,
          // and re-pointing it would move ANOTHER section's history.
          return reject("请修正标红的输入后重试。", {
            name: "原课名已被别名指向其他课,改名会覆盖该映射。请先处理该别名后重试。",
          });
        case "alias-shadow":
          return reject("请修正标红的输入后重试。", {
            name: `「${name.value}」已是其他课的别名,改成它会把那个课的历史考勤并过来。`,
          });
      }
    }
    // Backstops for the same two conditions arriving as constraint violations - a
    // concurrent write can slip between the repository's check and its update.
    const failed = prismaErrorCode(error);
    if (failed === UNIQUE_VIOLATION) {
      return reject("请修正标红的输入后重试。", {
        name: `本部门下已有「${name.value}」,请换一个名称。`,
      });
    }
    if (failed === RECORD_NOT_FOUND) {
      return reject("该课已不存在,请刷新页面后重试。");
    }
    console.error(`[renameSection] failed for id=${input.id} name=${name.value}`, error);
    return reject("改名失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAdmin("renameSection");
  return { ok: true };
}

export interface CreateSectionInput {
  departmentId: string;
  /** New section name. Unique within its department (`@@unique([departmentId, name])`). */
  nameRaw: string;
  sortOrderRaw: string;
  managerNameRaw?: string | null;
  managerEmailRaw?: string | null;
}

/**
 * Adds one section under an existing department.
 *
 * Goes through upsertSection() - the same natural-key write the Excel import uses -
 * so a name that already exists in this department UPDATES that row instead of
 * failing. That is deliberate and matches D-153 (org changes arrive as a full
 * re-upload, history is never deleted): the alternative, a create() that reports
 * "该课已存在", would leave the administrator unable to fix a row they can see.
 * The section list refreshes below, so the merge is visible immediately.
 */
export async function createSection(
  input: CreateSectionInput,
): Promise<AdminActionResult<SectionField>> {
  if (typeof input?.departmentId !== "string" || input.departmentId.trim() === "") {
    return reject("请先选择所属部门。");
  }

  const fieldErrors: Partial<Record<SectionField, string>> = {};

  const name = parseRequiredText(input.nameRaw, "课名称", 50);
  if ("error" in name) {
    fieldErrors.name = name.error;
  }
  const sortOrder = parseSortOrder(input.sortOrderRaw);
  if ("error" in sortOrder) {
    fieldErrors.sortOrder = sortOrder.error;
  }
  const managerName = parseOptionalText(input.managerNameRaw, "责任者", 50);
  if ("error" in managerName) {
    fieldErrors.managerName = managerName.error;
  }
  const managerEmail = parseOptionalEmail(input.managerEmailRaw, 100);
  if ("error" in managerEmail) {
    fieldErrors.managerEmail = managerEmail.error;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return reject("请修正标红的输入后重试。", fieldErrors);
  }
  if (
    "error" in name ||
    "error" in sortOrder ||
    "error" in managerName ||
    "error" in managerEmail
  ) {
    return reject("请修正标红的输入后重试。", fieldErrors);
  }

  try {
    await upsertSection({
      departmentId: input.departmentId,
      name: name.value,
      sortOrder: sortOrder.value,
      managerName: managerName.value,
      managerEmail: managerEmail.value,
    });
  } catch (error) {
    const failed = prismaErrorCode(error);
    // P2003: the departmentId does not exist. Reachable when the page was rendered
    // before that department was removed elsewhere.
    if (failed === "P2003" || failed === RECORD_NOT_FOUND) {
      return reject("所属部门已不存在,请刷新页面后重试。");
    }
    console.error(
      `[createSection] failed for department=${input.departmentId} name=${name.value}`,
      error,
    );
    return reject("保存失败,数据未写入。请重试;若持续失败请联系管理员。");
  }

  revalidateAdmin("createSection");
  return { ok: true };
}
