"use client";

// Write-capable organisation editor (部 -> 課 hierarchy).
//
// The only organisation surface: it replaced a read-only server-rendered table, which
// was deleted once every field it showed became editable here. Parent/child structure
// comes from ./org-grouping, which stays a separate pure module so the grouping and
// orphan-detection rules can be unit-tested without mounting a client component.
//
// Commit model: one explicit 保存 button per row, matching JobTitleRuleEditor. A row
// here is four fields, so committing on blur would fire up to four writes for one edit.
//
// Renaming a 课 is a SEPARATE commit from that row's 保存 button, on its own 改名
// button behind a confirmation dialog. Not folded into 保存 because a rename is not a
// column edit: renameSection() writes a SectionAlias alongside the new name so
// historical attendance keeps resolving, and it can be refused for reasons the other
// columns cannot produce. One 保存 meaning two different transactions would hide that.
//
// SCOPE - what is deliberately NOT editable here, and why:
//
//   - `name` on a DEPARTMENT. buildSectionIndex() keys sections on aliasKey(部名, 课名),
//     so the department name is part of every section's lookup key: renaming one
//     department breaks the historical match for ALL of its sections at once, and
//     compensating needs one alias per section rather than one. Its own work, by blast
//     radius. `DepartmentPatch` omits `name` for that reason; `SectionPatch` omits it
//     too, so that renameSectionWithAlias() stays the only path that can rename a
//     section - see that function for why a bare rename loses history silently.
//
//   - Deletion. Section is referenced with onDelete: Restrict by Plan, Actual,
//     SectionAlias and AttendanceRaw, so deleting a populated one surfaces a raw
//     English FK message. Useful deletion means checking all four references and
//     naming each blocker - also separate work.
//
//   - Adding a DEPARTMENT. Departments arrive through the Excel import; adding one
//     here with no sections under it would render an empty branch that the import
//     cannot fill until the department name appears in a sheet anyway.
//
// So: sortOrder / 责任者 / 邮箱 on every row, `code` on departments, the 课 name behind
// 改名, plus adding a section under an existing department.

import { useCallback, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { findOrphanSections, groupByDepartment } from "./org-grouping";
import {
  createSection,
  renameSection,
  saveDepartment,
  saveSection,
  type DepartmentField,
  type SectionField,
} from "../actions";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DepartmentDto, SectionDto } from "@/lib/db/types";

const TEXT_MAX_LENGTH = 50;
const CODE_MAX_LENGTH = 20;
const EMAIL_MAX_LENGTH = 100;

/** Every editable field of either level, so one draft shape covers both tables. */
type OrgField = DepartmentField | SectionField;

interface RowDraft {
  code: string;
  sortOrder: string;
  managerName: string;
  managerEmail: string;
  status: "idle" | "saving" | "error";
  fieldErrors: Partial<Record<OrgField, string>>;
}

interface NewSectionDraft extends RowDraft {
  name: string;
}

/**
 * The rename awaiting confirmation, or in flight.
 *
 * Kept outside `RowDraft` because a rename is not one of that shape's fields: it is a
 * separate transaction, only ever applies to a 課, and has to survive the dialog being
 * open while the row underneath it stays otherwise editable.
 */
interface PendingRename {
  section: SectionDto;
  /** Already trimmed - what the dialog shows and what gets submitted. */
  nextName: string;
  status: "confirming" | "saving";
}

/**
 * The row's stored values as strings.
 *
 * `sortOrder` is stringified rather than kept numeric because the Server Action takes
 * raw strings: sending a number would mean parsing in the browser, where "abc" becomes
 * NaN and blank becomes 0 before the layer that knows what those mean sees them.
 */
function draftFromDepartment(department: DepartmentDto): RowDraft {
  return {
    code: department.code ?? "",
    sortOrder: String(department.sortOrder),
    managerName: department.managerName ?? "",
    managerEmail: department.managerEmail ?? "",
    status: "idle",
    fieldErrors: {},
  };
}

function draftFromSection(section: SectionDto): RowDraft {
  return {
    // Sections have no `code` column; the field is present so one draft type serves
    // both levels, and is never rendered or submitted for a section.
    code: "",
    sortOrder: String(section.sortOrder),
    managerName: section.managerName ?? "",
    managerEmail: section.managerEmail ?? "",
    status: "idle",
    fieldErrors: {},
  };
}

function emptyNewSection(): NewSectionDraft {
  return {
    name: "",
    code: "",
    sortOrder: "",
    managerName: "",
    managerEmail: "",
    status: "idle",
    fieldErrors: {},
  };
}

function isDepartmentDirty(department: DepartmentDto, draft: RowDraft | undefined): boolean {
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

function isSectionDirty(section: SectionDto, draft: RowDraft | undefined): boolean {
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
function omitKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [entryKey, value] of Object.entries(source)) {
    if (entryKey !== key) {
      next[entryKey] = value;
    }
  }
  return next;
}

const HEAD_CLASS =
  "py-2 pr-4 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";

/** One editable cell: value, per-field error surfaced on the input, error cleared on type. */
function EditCell({
  value,
  field,
  label,
  placeholder,
  maxLength,
  disabled,
  error,
  align,
  onChange,
}: {
  value: string;
  field: OrgField;
  label: string;
  placeholder?: string;
  maxLength: number;
  disabled: boolean;
  error: string | undefined;
  align?: "right";
  onChange: (field: OrgField, next: string) => void;
}): ReactElement {
  return (
    <Input
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={error !== undefined}
      title={error}
      className={align === "right" ? "text-right tabular-nums" : undefined}
      onChange={(event) => onChange(field, event.target.value)}
    />
  );
}

export function OrgEditor({
  departments,
  sections,
}: {
  departments: readonly DepartmentDto[];
  sections: readonly SectionDto[];
}): ReactElement {
  const groups = groupByDepartment(departments, sections);
  const orphans = findOrphanSections(departments, sections);

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  /** Section id -> 课名 being typed. Absent means untouched, so the row reads props. */
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  /** Section id -> why its last rename was refused. Cleared on the next keystroke. */
  const [nameErrors, setNameErrors] = useState<Record<string, string>>({});
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  /** Department id whose "add section" row is open; null when none is. */
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [newSection, setNewSection] = useState<NewSectionDraft>(emptyNewSection);

  /** Seeds a draft from props on first touch, then applies `mutate`. */
  const patch = useCallback(
    (id: string, seed: () => RowDraft, mutate: (draft: RowDraft) => RowDraft): void => {
      setDrafts((previous) => {
        const current = previous[id] ?? seed();
        return { ...previous, [id]: mutate(current) };
      });
    },
    [],
  );

  /** Field edit on a stored row: writes the value and clears that field's error. */
  const editField = useCallback(
    (id: string, seed: () => RowDraft, field: OrgField, next: string): void => {
      patch(id, seed, (current) => ({
        ...current,
        [field]: next,
        status: "idle",
        fieldErrors: omitKey(current.fieldErrors, field) as RowDraft["fieldErrors"],
      }));
    },
    [patch],
  );

  const handleSaveDepartment = useCallback(
    async (department: DepartmentDto, submitted: RowDraft): Promise<void> => {
      if (submitted.status === "saving") {
        return;
      }
      const seed = () => draftFromDepartment(department);
      patch(department.id, seed, (draft) => ({ ...draft, status: "saving", fieldErrors: {} }));

      const result = await saveDepartment({
        id: department.id,
        codeRaw: submitted.code,
        sortOrderRaw: submitted.sortOrder,
        managerNameRaw: submitted.managerName,
        managerEmailRaw: submitted.managerEmail,
      });

      if (result.ok) {
        // Draft dropped rather than marked clean: revalidatePath("/admin") re-renders
        // with the stored row, and an absent draft reads straight from props.
        setDrafts((previous) => omitKey(previous, department.id));
        toast.success(`${department.name} 已保存`);
        return;
      }
      patch(department.id, seed, (draft) => ({
        ...draft,
        status: "error",
        fieldErrors: result.fieldErrors,
      }));
      toast.error(`${department.name}: ${result.message}`);
    },
    [patch],
  );

  const handleSaveSection = useCallback(
    async (section: SectionDto, submitted: RowDraft): Promise<void> => {
      if (submitted.status === "saving") {
        return;
      }
      const seed = () => draftFromSection(section);
      patch(section.id, seed, (draft) => ({ ...draft, status: "saving", fieldErrors: {} }));

      const result = await saveSection({
        id: section.id,
        sortOrderRaw: submitted.sortOrder,
        managerNameRaw: submitted.managerName,
        managerEmailRaw: submitted.managerEmail,
      });

      if (result.ok) {
        setDrafts((previous) => omitKey(previous, section.id));
        toast.success(`${section.name} 已保存`);
        return;
      }
      patch(section.id, seed, (draft) => ({
        ...draft,
        status: "error",
        fieldErrors: result.fieldErrors,
      }));
      toast.error(`${section.name}: ${result.message}`);
    },
    [patch],
  );

  /** 课名 edit: stores the keystroke and clears the previous refusal for that row. */
  const editName = useCallback((sectionId: string, next: string): void => {
    setNameDrafts((previous) => ({ ...previous, [sectionId]: next }));
    setNameErrors((previous) =>
      previous[sectionId] === undefined ? previous : omitKey(previous, sectionId),
    );
  }, []);

  const confirmRename = useCallback(async (pending: PendingRename): Promise<void> => {
    if (pending.status === "saving") {
      return;
    }
    setPendingRename({ ...pending, status: "saving" });
    const { section, nextName } = pending;

    const result = await renameSection({ id: section.id, nameRaw: nextName });

    setPendingRename(null);
    if (result.ok) {
      // Draft dropped rather than kept: revalidatePath("/admin") re-renders with the
      // stored name, and an absent draft reads straight from props.
      setNameDrafts((previous) => omitKey(previous, section.id));
      toast.success(`${section.name} 已改名为 ${nextName}`, {
        description: "历史考勤中的原课名已登记为别名,继续匹配到本课。",
      });
      return;
    }
    // The typed value is left in place on purpose - the operator has to be able to see
    // and fix what was refused.
    setNameErrors((previous) => ({
      ...previous,
      [section.id]: result.fieldErrors.name ?? result.message,
    }));
    toast.error(`${section.name}: ${result.fieldErrors.name ?? result.message}`);
    // setPendingRename is listed because this callback awaits: the React Compiler
    // cannot prove the setter is the stable one across the await, and rejects [].
  }, [setPendingRename]);

  const handleCreateSection = useCallback(
    async (departmentId: string, departmentName: string, submitted: NewSectionDraft) => {
      if (submitted.status === "saving") {
        return;
      }
      setNewSection((previous) => ({ ...previous, status: "saving", fieldErrors: {} }));

      const result = await createSection({
        departmentId,
        nameRaw: submitted.name,
        sortOrderRaw: submitted.sortOrder,
        managerNameRaw: submitted.managerName,
        managerEmailRaw: submitted.managerEmail,
      });

      if (result.ok) {
        setNewSection(emptyNewSection());
        setAddingUnder(null);
        toast.success(`已在 ${departmentName} 下保存 ${submitted.name.trim()}`, {
          description: "若该课名已存在,则为更新而非新建。",
        });
        return;
      }
      setNewSection((previous) => ({
        ...previous,
        status: "error",
        fieldErrors: result.fieldErrors,
      }));
      toast.error(result.message);
    },
    [],
  );

  const editNewSection = useCallback((field: OrgField, next: string): void => {
    setNewSection((previous) => ({
      ...previous,
      [field]: next,
      status: "idle",
      fieldErrors: omitKey(previous.fieldErrors, field) as RowDraft["fieldErrors"],
    }));
  }, []);

  const newSectionSaving = newSection.status === "saving";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          组织结构编辑表。可修改排序、责任者、邮箱与部门编码,并在部门下新增课。
          课名称可通过「改名」按钮修改,原名会登记为别名以保留历史考勤匹配;部门名称不可修改。每行独立保存。
        </caption>
        <thead>
          <tr className="border-y border-border bg-muted/40 text-left">
            <th scope="col" className={`${HEAD_CLASS} pl-4`}>
              组织
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-24`}>
              编码
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-20`}>
              排序
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-36`}>
              责任者
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-52`}>
              邮箱
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-44 text-right`}>
              操作
            </th>
          </tr>
        </thead>
        {groups.map((group) => {
            const department = group.department;
            const draft = drafts[department.id];
            const effective = draft ?? draftFromDepartment(department);
            const saving = effective.status === "saving";
            const dirty = isDepartmentDirty(department, draft);
            const seed = () => draftFromDepartment(department);
            const isAdding = addingUnder === department.id;

            return (
              <tbody key={department.id} className="border-b border-border">
                <tr
                  className={`border-l-2 border-l-plan ${
                    effective.status === "error" ? "bg-warn/10" : dirty ? "bg-plan/5" : "bg-muted/20"
                  }`}
                >
                  <th scope="row" className="py-2 pr-4 pl-4 text-left font-semibold">
                    {department.name}
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                      下挂 {group.sections.length} 课
                    </span>
                  </th>
                  <td className="py-2 pr-4">
                    <EditCell
                      value={effective.code}
                      field="code"
                      label={`${department.name} 部门编码`}
                      placeholder="可选"
                      maxLength={CODE_MAX_LENGTH}
                      disabled={saving}
                      error={effective.fieldErrors.code}
                      onChange={(field, next) => editField(department.id, seed, field, next)}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <EditCell
                      value={effective.sortOrder}
                      field="sortOrder"
                      label={`${department.name} 排序`}
                      maxLength={5}
                      disabled={saving}
                      error={effective.fieldErrors.sortOrder}
                      align="right"
                      onChange={(field, next) => editField(department.id, seed, field, next)}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <EditCell
                      value={effective.managerName}
                      field="managerName"
                      label={`${department.name} 责任者`}
                      placeholder="可选"
                      maxLength={TEXT_MAX_LENGTH}
                      disabled={saving}
                      error={effective.fieldErrors.managerName}
                      onChange={(field, next) => editField(department.id, seed, field, next)}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <EditCell
                      value={effective.managerEmail}
                      field="managerEmail"
                      label={`${department.name} 邮箱`}
                      placeholder="可选"
                      maxLength={EMAIL_MAX_LENGTH}
                      disabled={saving}
                      error={effective.fieldErrors.managerEmail}
                      onChange={(field, next) => editField(department.id, seed, field, next)}
                    />
                  </td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!dirty || saving}
                      onClick={() => void handleSaveDepartment(department, effective)}
                    >
                      {saving ? "保存中" : "保存"}
                    </Button>
                  </td>
                </tr>

                {group.sections.map((section) => {
                  const sectionDraft = drafts[section.id];
                  const sectionEffective = sectionDraft ?? draftFromSection(section);
                  const sectionSaving = sectionEffective.status === "saving";
                  const sectionDirty = isSectionDirty(section, sectionDraft);
                  const sectionSeed = () => draftFromSection(section);
                  const nameValue = nameDrafts[section.id] ?? section.name;
                  const nameError = nameErrors[section.id];
                  const renaming =
                    pendingRename !== null &&
                    pendingRename.section.id === section.id &&
                    pendingRename.status === "saving";
                  // Blank is not "dirty": it would only ever be refused by the action,
                  // and enabling 改名 for it invites a pointless round trip.
                  const nameDirty = nameValue.trim() !== "" && nameValue.trim() !== section.name;

                  return (
                    <tr
                      key={section.id}
                      className={`border-t border-border/40 ${
                        sectionEffective.status === "error"
                          ? "bg-warn/10"
                          : sectionDirty
                            ? "bg-plan/5"
                            : ""
                      }`}
                    >
                      <th scope="row" className="py-2 pr-4 pl-8 text-left font-normal">
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground/50">└</span>
                          <Input
                            value={nameValue}
                            disabled={renaming}
                            maxLength={TEXT_MAX_LENGTH}
                            aria-label={`${department.name} 下 ${section.name} 的课名称`}
                            aria-invalid={nameError !== undefined}
                            title={nameError}
                            onChange={(event) => editName(section.id, event.target.value)}
                          />
                        </div>
                      </th>
                      {/* Sections have no code column - the cell is held open so the
                          five columns stay aligned with the department rows above. */}
                      <td className="py-2 pr-4 text-center text-muted-foreground/40">—</td>
                      <td className="py-2 pr-4">
                        <EditCell
                          value={sectionEffective.sortOrder}
                          field="sortOrder"
                          label={`${section.name} 排序`}
                          maxLength={5}
                          disabled={sectionSaving}
                          error={sectionEffective.fieldErrors.sortOrder}
                          align="right"
                          onChange={(field, next) => editField(section.id, sectionSeed, field, next)}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <EditCell
                          value={sectionEffective.managerName}
                          field="managerName"
                          label={`${section.name} 责任者`}
                          placeholder="可选"
                          maxLength={TEXT_MAX_LENGTH}
                          disabled={sectionSaving}
                          error={sectionEffective.fieldErrors.managerName}
                          onChange={(field, next) => editField(section.id, sectionSeed, field, next)}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <EditCell
                          value={sectionEffective.managerEmail}
                          field="managerEmail"
                          label={`${section.name} 邮箱`}
                          placeholder="可选"
                          maxLength={EMAIL_MAX_LENGTH}
                          disabled={sectionSaving}
                          error={sectionEffective.fieldErrors.managerEmail}
                          onChange={(field, next) => editField(section.id, sectionSeed, field, next)}
                        />
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!nameDirty || renaming || sectionSaving}
                          onClick={() =>
                            setPendingRename({
                              section,
                              nextName: nameValue.trim(),
                              status: "confirming",
                            })
                          }
                        >
                          {renaming ? "改名中" : "改名"}
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          className="ml-1"
                          disabled={!sectionDirty || sectionSaving || renaming}
                          onClick={() => void handleSaveSection(section, sectionEffective)}
                        >
                          {sectionSaving ? "保存中" : "保存"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}

                {isAdding ? (
                  <tr className="border-t border-border/40 bg-muted/30">
                    <td className="py-2.5 pr-4 pl-8">
                      <Input
                        value={newSection.name}
                        disabled={newSectionSaving}
                        maxLength={TEXT_MAX_LENGTH}
                        aria-label={`${department.name} 下新增课的名称`}
                        aria-invalid={newSection.fieldErrors.name !== undefined}
                        title={newSection.fieldErrors.name}
                        placeholder="新课名称"
                        onChange={(event) => editNewSection("name", event.target.value)}
                      />
                    </td>
                    <td className="py-2.5 pr-4 text-center text-muted-foreground/40">—</td>
                    <td className="py-2.5 pr-4">
                      <EditCell
                        value={newSection.sortOrder}
                        field="sortOrder"
                        label="新增课的排序"
                        placeholder="0"
                        maxLength={5}
                        disabled={newSectionSaving}
                        error={newSection.fieldErrors.sortOrder}
                        align="right"
                        onChange={(field, next) => editNewSection(field, next)}
                      />
                    </td>
                    <td className="py-2.5 pr-4">
                      <EditCell
                        value={newSection.managerName}
                        field="managerName"
                        label="新增课的责任者"
                        placeholder="可选"
                        maxLength={TEXT_MAX_LENGTH}
                        disabled={newSectionSaving}
                        error={newSection.fieldErrors.managerName}
                        onChange={(field, next) => editNewSection(field, next)}
                      />
                    </td>
                    <td className="py-2.5 pr-4">
                      <EditCell
                        value={newSection.managerEmail}
                        field="managerEmail"
                        label="新增课的邮箱"
                        placeholder="可选"
                        maxLength={EMAIL_MAX_LENGTH}
                        disabled={newSectionSaving}
                        error={newSection.fieldErrors.managerEmail}
                        onChange={(field, next) => editNewSection(field, next)}
                      />
                    </td>
                    <td className="py-2.5 pr-4 text-right whitespace-nowrap">
                      <Button
                        size="xs"
                        disabled={newSection.name.trim() === "" || newSectionSaving}
                        onClick={() =>
                          void handleCreateSection(department.id, department.name, newSection)
                        }
                      >
                        {newSectionSaving ? "保存中" : "保存"}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="ml-1"
                        disabled={newSectionSaving}
                        onClick={() => {
                          setAddingUnder(null);
                          setNewSection(emptyNewSection());
                        }}
                      >
                        取消
                      </Button>
                    </td>
                  </tr>
                ) : (
                  <tr className="border-t border-border/40">
                    <td colSpan={6} className="py-1.5 pl-8">
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => {
                          // Resetting on open rather than on close: a draft abandoned
                          // by navigating away would otherwise reappear under a
                          // different department the next time this row is opened.
                          setNewSection(emptyNewSection());
                          setAddingUnder(department.id);
                        }}
                      >
                        + 在{department.name}下新增课
                      </Button>
                    </td>
                  </tr>
                )}
              </tbody>
            );
        })}
      </table>

      {orphans.length > 0 ? (
        <div className="mt-4 border-l-2 border-l-actual bg-actual/10 px-4 py-3">
          <p className="text-xs font-semibold">
            未归属部门（{orphans.length} 课,数据异常）
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            这些课的 departmentId 在部门表中找不到对应记录,无法在此编辑。
            请检查组织导入数据后重新上传。
          </p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {orphans.map((section) => (
              <li key={section.id} className="text-muted-foreground">
                {section.name}
                <span className="ml-2 font-mono text-[11px] opacity-60">
                  departmentId={section.departmentId}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="px-4 pt-3 text-xs text-muted-foreground">
        课名称改名后,原课名会登记为别名,历史考勤数据仍会匹配到本课。
        部门名称是所有下属课的匹配键的一部分,不在本页范围内。
        删除同样不在本页范围内(存在计划/实绩引用)。
      </p>

      {pendingRename === null ? null : (
        <AlertDialog
          open
          onOpenChange={(open) => {
            // Escape is the only route to false - neither button is a Close part - and
            // it means the same as 取消: close, write nothing, keep what was typed.
            if (!open && pendingRename.status !== "saving") {
              setPendingRename(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>确认修改课名称</AlertDialogTitle>
            <AlertDialogDescription>
              该课的历史考勤数据按「部名 + 课名」匹配,改名后原名会登记为别名。
            </AlertDialogDescription>

            <dl className="mt-3 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">原课名</dt>
                <dd className="font-medium">{pendingRename.section.name}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">新课名</dt>
                <dd className="font-medium text-plan">{pendingRename.nextName}</dd>
              </div>
            </dl>

            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>历史考勤会通过别名继续匹配到本课,计划与实绩不会被拆分。</li>
              <li>本次改名会记入主数据修改履历。</li>
              <li>若新课名已被本部门其他课或其别名占用,改名会被拒绝,数据不变。</li>
            </ul>

            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={pendingRename.status === "saving"}
                onClick={() => setPendingRename(null)}
              >
                取消
              </Button>
              <Button
                disabled={pendingRename.status === "saving"}
                onClick={() => void confirmRename(pendingRename)}
              >
                {pendingRename.status === "saving" ? "改名中" : "确认改名"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
