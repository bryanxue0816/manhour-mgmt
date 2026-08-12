"use client";

// Job-title exclusion rules editor (D-109 / D-156: management ranks whose personnel
// and/or overtime hours are excluded from the aggregates).
//
// Commit model: EXPLICIT per-row 保存 button, not blur-commit like the plan grid.
// The plan grid commits on blur because a cell is one number typed in one motion, so
// leaving it unambiguously ends the edit. A rule row is a mixed set - two checkboxes
// and a free-text remark - where clicking a checkbox and then clicking the next
// checkbox is one intent, not two writes. An explicit button also gives the "新增规则"
// row somewhere to live, which a blur handler cannot provide.
//
// `jobTitle` is NOT editable on a stored row. It is the @id column, so changing it
// would not rename the rule - it would insert a second rule and leave the original
// row in place, silently keeping the old exclusion active. Renaming means delete +
// re-add, and deletion is out of scope for this batch.
//
// Accessibility rule this file must keep: every checkbox is paired with visible text
// stating what its state MEANS (排除 / 计入). A tick shape and a colour say nothing to
// a screen reader and little to a colour-blind operator - the same rule D-124's status
// dots follow, and the reason components/ui/checkbox.tsx carries the note it does.

import { useCallback, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { saveJobTitleRule, type JobTitleRuleField } from "../actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { JobTitleRuleDto } from "@/lib/db/types";

const REMARK_MAX_LENGTH = 200;
const JOB_TITLE_MAX_LENGTH = 50;

/** Editable state of one row. Untouched rows have no entry and render from props. */
interface RuleDraft {
  excludePersonnelHours: boolean;
  excludeOvertimeHours: boolean;
  remark: string;
  status: "idle" | "saving" | "error";
  fieldErrors: Partial<Record<JobTitleRuleField, string>>;
}

/** State of the single "add rule" row, which has no stored counterpart. */
interface NewRuleDraft extends RuleDraft {
  jobTitle: string;
}

const EMPTY_NEW_RULE: NewRuleDraft = {
  jobTitle: "",
  excludePersonnelHours: false,
  excludeOvertimeHours: false,
  remark: "",
  status: "idle",
  fieldErrors: {},
};

/**
 * Returns a copy of `source` without `key`, leaving the input untouched.
 *
 * Written out rather than destructured with a discarded rest-sibling because the
 * discarded binding reads as dead code to the linter, and rather than `delete` on the
 * state object itself because that would mutate the previous React state.
 */
function omitKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [entryKey, value] of Object.entries(source)) {
    if (entryKey !== key) {
      next[entryKey] = value;
    }
  }
  return next;
}

function draftFromRule(rule: JobTitleRuleDto): RuleDraft {
  return {
    excludePersonnelHours: rule.excludePersonnelHours,
    excludeOvertimeHours: rule.excludeOvertimeHours,
    // null and "" are the same thing to an input; the action turns blank back into null.
    remark: rule.remark ?? "",
    status: "idle",
    fieldErrors: {},
  };
}

/** True when the draft differs from what is stored - drives the 保存 button. */
function isDirty(rule: JobTitleRuleDto, draft: RuleDraft | undefined): boolean {
  if (draft === undefined) {
    return false;
  }
  return (
    draft.excludePersonnelHours !== rule.excludePersonnelHours ||
    draft.excludeOvertimeHours !== rule.excludeOvertimeHours ||
    draft.remark !== (rule.remark ?? "")
  );
}

/**
 * A checkbox plus the words for its current state.
 *
 * The label text changes with the value (排除 when on, 计入 when off) rather than
 * naming the column again: the column header already says which hours are meant, and
 * what an operator needs at the row level is what this row currently DOES.
 */
function ExclusionToggle({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 select-none">
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span
        className={
          checked ? "text-xs font-medium text-warn" : "text-xs text-muted-foreground"
        }
      >
        {checked ? "排除" : "计入"}
      </span>
    </label>
  );
}

const HEAD_CLASS =
  "py-2 pr-4 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";

export function JobTitleRuleEditor({
  rules,
}: {
  rules: readonly JobTitleRuleDto[];
}): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [newRule, setNewRule] = useState<NewRuleDraft>(EMPTY_NEW_RULE);

  /** Seeds a draft from props on first touch, then applies `mutate`. */
  const patch = useCallback(
    (rule: JobTitleRuleDto, mutate: (draft: RuleDraft) => RuleDraft): void => {
      setDrafts((previous) => {
        const current = previous[rule.jobTitle] ?? draftFromRule(rule);
        return { ...previous, [rule.jobTitle]: mutate(current) };
      });
    },
    [],
  );

  const handleSave = useCallback(
    async (rule: JobTitleRuleDto, submitted: RuleDraft): Promise<void> => {
      if (submitted.status === "saving") {
        return;
      }
      patch(rule, (draft) => ({ ...draft, status: "saving", fieldErrors: {} }));

      const result = await saveJobTitleRule({
        jobTitleRaw: rule.jobTitle,
        excludePersonnelHours: submitted.excludePersonnelHours,
        excludeOvertimeHours: submitted.excludeOvertimeHours,
        remarkRaw: submitted.remark,
        isCreate: false,
      });

      if (result.ok) {
        // The draft is dropped, not marked clean: revalidatePath("/admin") re-renders
        // this component with the stored row, and an absent draft reads straight from
        // props. Keeping one would pin the row to a value the server may have adjusted.
        setDrafts((previous) => omitKey(previous, rule.jobTitle));
        toast.success(`${rule.jobTitle} 规则已保存`);
        return;
      }

      patch(rule, (draft) => ({
        ...draft,
        status: "error",
        fieldErrors: result.fieldErrors,
      }));
      toast.error(`${rule.jobTitle}: ${result.message}`);
    },
    [patch],
  );

  const handleCreate = useCallback(
    async (submitted: NewRuleDraft): Promise<void> => {
      if (submitted.status === "saving") {
        return;
      }
      setNewRule((previous) => ({ ...previous, status: "saving", fieldErrors: {} }));

      const result = await saveJobTitleRule({
        jobTitleRaw: submitted.jobTitle,
        excludePersonnelHours: submitted.excludePersonnelHours,
        excludeOvertimeHours: submitted.excludeOvertimeHours,
        remarkRaw: submitted.remark,
        isCreate: true,
      });

      if (result.ok) {
        // Reset so the row is ready for the next addition - the saved rule appears in
        // the table below once the server re-render arrives.
        setNewRule(EMPTY_NEW_RULE);
        toast.success(`已新增规则 ${submitted.jobTitle.trim()}`);
        return;
      }

      setNewRule((previous) => ({
        ...previous,
        status: "error",
        fieldErrors: result.fieldErrors,
      }));
      toast.error(result.message);
    },
    [],
  );

  const newRuleSaving = newRule.status === "saving";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          职位工时排除规则。勾选后该职位的对应工时不计入统计,取消勾选则计入。
          每行独立保存。
        </caption>
        <thead>
          <tr className="border-y border-border bg-muted/40 text-left">
            <th scope="col" className={`${HEAD_CLASS} pl-4`}>
              职位
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-28`}>
              人员工时
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-28`}>
              加班工时
            </th>
            <th scope="col" className={HEAD_CLASS}>
              备注
            </th>
            <th scope="col" className={`${HEAD_CLASS} w-24 text-right`}>
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const draft = drafts[rule.jobTitle];
            const effective = draft ?? draftFromRule(rule);
            const saving = effective.status === "saving";
            const dirty = isDirty(rule, draft);
            const remarkError = effective.fieldErrors.remark;

            return (
              <tr
                key={rule.jobTitle}
                className={`border-b border-border/50 ${
                  effective.status === "error" ? "bg-warn/10" : dirty ? "bg-plan/5" : ""
                }`}
              >
                <th scope="row" className="py-2 pr-4 pl-4 text-left font-medium">
                  {rule.jobTitle}
                </th>
                <td className="py-2 pr-4">
                  <ExclusionToggle
                    checked={effective.excludePersonnelHours}
                    disabled={saving}
                    ariaLabel={`${rule.jobTitle} 排除人员工时`}
                    onChange={(next) =>
                      patch(rule, (current) => ({
                        ...current,
                        excludePersonnelHours: next,
                        status: "idle",
                      }))
                    }
                  />
                </td>
                <td className="py-2 pr-4">
                  <ExclusionToggle
                    checked={effective.excludeOvertimeHours}
                    disabled={saving}
                    ariaLabel={`${rule.jobTitle} 排除加班工时`}
                    onChange={(next) =>
                      patch(rule, (current) => ({
                        ...current,
                        excludeOvertimeHours: next,
                        status: "idle",
                      }))
                    }
                  />
                </td>
                <td className="py-2 pr-4">
                  <Input
                    value={effective.remark}
                    disabled={saving}
                    maxLength={REMARK_MAX_LENGTH}
                    aria-label={`${rule.jobTitle} 备注`}
                    aria-invalid={remarkError !== undefined}
                    title={remarkError}
                    placeholder="可选"
                    onChange={(event) =>
                      patch(rule, (current) => {
                        const remaining = { ...current.fieldErrors };
                        delete remaining.remark;
                        return {
                          ...current,
                          remark: event.target.value,
                          status: "idle",
                          fieldErrors: remaining,
                        };
                      })
                    }
                  />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!dirty || saving}
                    onClick={() => void handleSave(rule, effective)}
                  >
                    {saving ? "保存中" : "保存"}
                  </Button>
                </td>
              </tr>
            );
          })}

          {/* Add row. Separated by a heavier top border so it reads as a form, not as
              another rule - it holds no data until saved. */}
          <tr className="border-t-2 border-border bg-muted/20">
            <td className="py-2.5 pr-4 pl-4">
              <Input
                value={newRule.jobTitle}
                disabled={newRuleSaving}
                maxLength={JOB_TITLE_MAX_LENGTH}
                aria-label="新增规则的职位名称"
                aria-invalid={newRule.fieldErrors.jobTitle !== undefined}
                title={newRule.fieldErrors.jobTitle}
                placeholder="新增职位,例如 部长"
                onChange={(event) =>
                  setNewRule((previous) => {
                    const remaining = { ...previous.fieldErrors };
                    delete remaining.jobTitle;
                    return {
                      ...previous,
                      jobTitle: event.target.value,
                      status: "idle",
                      fieldErrors: remaining,
                    };
                  })
                }
              />
            </td>
            <td className="py-2.5 pr-4">
              <ExclusionToggle
                checked={newRule.excludePersonnelHours}
                disabled={newRuleSaving}
                ariaLabel="新增规则 排除人员工时"
                onChange={(next) =>
                  setNewRule((previous) => ({
                    ...previous,
                    excludePersonnelHours: next,
                    status: "idle",
                  }))
                }
              />
            </td>
            <td className="py-2.5 pr-4">
              <ExclusionToggle
                checked={newRule.excludeOvertimeHours}
                disabled={newRuleSaving}
                ariaLabel="新增规则 排除加班工时"
                onChange={(next) =>
                  setNewRule((previous) => ({
                    ...previous,
                    excludeOvertimeHours: next,
                    status: "idle",
                  }))
                }
              />
            </td>
            <td className="py-2.5 pr-4">
              <Input
                value={newRule.remark}
                disabled={newRuleSaving}
                maxLength={REMARK_MAX_LENGTH}
                aria-label="新增规则的备注"
                aria-invalid={newRule.fieldErrors.remark !== undefined}
                title={newRule.fieldErrors.remark}
                placeholder="可选"
                onChange={(event) =>
                  setNewRule((previous) => {
                    const remaining = { ...previous.fieldErrors };
                    delete remaining.remark;
                    return {
                      ...previous,
                      remark: event.target.value,
                      status: "idle",
                      fieldErrors: remaining,
                    };
                  })
                }
              />
            </td>
            <td className="py-2.5 pr-4 text-right">
              <Button
                size="xs"
                disabled={newRule.jobTitle.trim() === "" || newRuleSaving}
                onClick={() => void handleCreate(newRule)}
              >
                {newRuleSaving ? "新增中" : "新增"}
              </Button>
            </td>
          </tr>
        </tbody>
      </table>

      <p className="px-4 pt-3 text-xs text-muted-foreground">
        「排除」表示该职位的对应工时不计入统计口径(D-109/D-156);「计入」表示正常统计。
        职位名称是规则的主键,已保存的行不可改名——改名请新增一条规则。
      </p>
    </div>
  );
}
