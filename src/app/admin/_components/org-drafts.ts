// Draft shapes and dirty-checking for OrgEditor.
//
// A separate pure module for the same reason ./org-grouping is one: these rules decide
// whether a 保存 button is enabled at all, which is the difference between a write that
// happens and one that does not, and they can be exercised without mounting a client
// component. Nothing here touches React or the DOM.

import type { DepartmentField, SectionField } from "../actions";
import type { DepartmentDto, SectionDto } from "@/lib/db/types";

/** Every editable field of either level, so one draft shape covers both tables. */
export type OrgField = DepartmentField | SectionField;

export interface RowDraft {
  code: string;
  sortOrder: string;
  managerName: string;
  managerEmail: string;
  /**
   * Optional why for the audit trail (D-184). Not a stored column - it belongs to the
   * one write it is submitted with, so it is always seeded blank and is discarded with
   * the draft on success.
   */
  reason: string;
  status: "idle" | "saving" | "error";
  fieldErrors: Partial<Record<OrgField, string>>;
}

export interface NewSectionDraft extends RowDraft {
  name: string;
}

/**
 * The row's stored values as strings.
 *
 * `sortOrder` is stringified rather than kept numeric because the Server Action takes
 * raw strings: sending a number would mean parsing in the browser, where "abc" becomes
 * NaN and blank becomes 0 before the layer that knows what those mean sees them.
 */
export function draftFromDepartment(department: DepartmentDto): RowDraft {
  return {
    code: department.code ?? "",
    sortOrder: String(department.sortOrder),
    managerName: department.managerName ?? "",
    managerEmail: department.managerEmail ?? "",
    // Always blank: there is no stored reason to read back. This also makes it the
    // baseline the dirty checks compare against, which is why typing one cannot on its
    // own enable 保存.
    reason: "",
    status: "idle",
    fieldErrors: {},
  };
}

export function draftFromSection(section: SectionDto): RowDraft {
  return {
    // Sections have no `code` column; the field is present so one draft type serves
    // both levels, and is never rendered or submitted for a section.
    code: "",
    sortOrder: String(section.sortOrder),
    managerName: section.managerName ?? "",
    managerEmail: section.managerEmail ?? "",
    reason: "",
    status: "idle",
    fieldErrors: {},
  };
}

export function emptyNewSection(): NewSectionDraft {
  return {
    name: "",
    code: "",
    sortOrder: "",
    managerName: "",
    managerEmail: "",
    reason: "",
    status: "idle",
    fieldErrors: {},
  };
}

/**
 * Whether the row differs from what is stored, i.e. whether 保存 does anything.
 *
 * `reason` is deliberately NOT compared, here or in isSectionDirty: it annotates a
 * change rather than being one, so a row where only the reason was typed has nothing to
 * write, and enabling 保存 for it would record a snapshot identical to the previous one
 * with an explanation of nothing.
 */
export function isDepartmentDirty(
  department: DepartmentDto,
  draft: RowDraft | undefined,
): boolean {
  if (draft === undefined) {
    return false;
  }
  const stored = draftFromDepartment(department);
  return (
    draft.code !== stored.code ||
    draft.sortOrder !== stored.sortOrder ||
    draft.managerName !== stored.managerName ||
    draft.managerEmail !== stored.managerEmail
  );
}

export function isSectionDirty(section: SectionDto, draft: RowDraft | undefined): boolean {
  if (draft === undefined) {
    return false;
  }
  const stored = draftFromSection(section);
  return (
    draft.sortOrder !== stored.sortOrder ||
    draft.managerName !== stored.managerName ||
    draft.managerEmail !== stored.managerEmail
  );
}

/** Copy of `source` without `key`, leaving the input untouched (React state is frozen). */
export function omitKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [entryKey, value] of Object.entries(source)) {
    if (entryKey !== key) {
      next[entryKey] = value;
    }
  }
  return next;
}
