"use client";

// Editable 24 x 12 plan grid (D-142: one admin, page-level single-cell edits).
//
// Commit model: PESSIMISTIC, on leaving a cell. Not on every keystroke, and not on
// leaving an individual input.
//
//   * Per keystroke would write "1", "10", "104", "1045" and log four audit entries
//     for one edit (D-143 wants a readable trail, not a keylog).
//   * Per input would fire while the operator is tabbing from 计划 to 挑战 within the
//     same cell, and a cell is a pair - both columns are NOT NULL, so a half-filled
//     new cell can only be rejected. The blur handler therefore sits on the <td> and
//     ignores focus moves that stay inside it.
//
// D-174 closes the question D-143 left open: leaving a cell now opens a confirmation
// dialog, and the reason is REQUIRED. This reverses what this file used to argue, and
// the reversal is deliberate - both of the old premises turned out to be wrong:
//
//   * "there is no dialog primitive in components/ui" - @base-ui/react was already a
//     dependency and already ships alert-dialog, so the cost was a wrapper, not a
//     package. See components/ui/alert-dialog.tsx.
//   * "a modal on each of 288 cells would cost an entry session more than it protects" -
//     bulk entry of all 288 cells goes through /plans/import (D-142), which has its own
//     one-shot overwrite confirmation (D-159). What reaches this grid is the post-hoc
//     single-cell correction, and that is exactly the edit worth stopping to justify.
//
// The reason therefore moved from once-per-session to once-per-edit. A session-level
// field was defensible while the reason was optional; once required, it would make 50
// unrelated edits share one sentence, which is a worse audit trail than collecting
// nothing. Required means required per edit, so the input lives inside the dialog.
//
// No exception for a first entry into an empty cell: "计划工时凭什么是这个数" is the
// question the trail has to answer, and it is no less relevant for the first value.

import { useCallback, useId, useRef, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { savePlanCell } from "../actions";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatHoursValue } from "@/lib/format";
import type { PlanGrid, PlanGridCell, PlanGridRow } from "@/lib/plans/grid";
import type { PlanField } from "@/lib/plans/validate";

/** Draft state for one touched cell. Untouched cells have no entry and read props. */
interface CellDraft {
  plannedRaw: string;
  challengeRaw: string;
  /** Last values known to be in the database - what Escape and a failed write restore. */
  committedPlanned: string;
  committedChallenge: string;
  status: "idle" | "saving" | "error";
  fieldErrors: Partial<Record<PlanField, string>>;
  /** True once this cell has a stored row, so a first insert stops looking absent. */
  present: boolean;
}

/**
 * An edit that has left its cell and is waiting for the operator to confirm it (D-174).
 *
 * The draft is captured here by value at blur time for the same reason the cell passes
 * it down: state read later in the closure would be stale, and the dialog must show and
 * write exactly the numbers the operator walked away from.
 */
interface PendingEdit {
  key: string;
  row: PlanGridRow;
  cell: PlanGridCell;
  submitted: CellDraft;
}

const REASON_MAX_LENGTH = 200;

function cellKey(sectionId: string, month: number): string {
  return `${sectionId}#${month}`;
}

/**
 * Renders a stored value for an input.
 *
 * No thousands separator: this is an editable field, and "1,045" is not something
 * parseHourInput accepts back. Absent cells render blank rather than "0" - the
 * distinction PlanGridCell.present exists to preserve.
 */
function toRaw(value: number, present: boolean): string {
  return present ? String(value) : "";
}

/**
 * Renders one side of the old -> new comparison in the confirmation dialog.
 *
 * A blank stands for an absent cell, and "0" would misreport it as a stored zero.
 */
function toComparison(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === "" ? "(空)" : trimmed;
}

/** Numeric view of a draft input, or null when it is blank or not a number. */
function numericOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function draftFromCell(cell: PlanGridCell): CellDraft {
  const planned = toRaw(cell.plannedHours, cell.present);
  const challenge = toRaw(cell.challengeHours, cell.present);
  return {
    plannedRaw: planned,
    challengeRaw: challenge,
    committedPlanned: planned,
    committedChallenge: challenge,
    status: "idle",
    fieldErrors: {},
    present: cell.present,
  };
}

/** One cell's two inputs. */
function GridCell({
  row,
  cell,
  draft,
  onEdit,
  onCommit,
  onRevert,
}: {
  row: PlanGridRow;
  cell: PlanGridCell;
  draft: CellDraft | undefined;
  onEdit: (field: PlanField, value: string) => void;
  onCommit: () => void;
  onRevert: () => void;
}): ReactElement {
  const plannedRaw = draft?.plannedRaw ?? toRaw(cell.plannedHours, cell.present);
  const challengeRaw = draft?.challengeRaw ?? toRaw(cell.challengeHours, cell.present);
  const present = draft?.present ?? cell.present;
  const saving = draft?.status === "saving";
  const errored = draft?.status === "error";

  const plannedValue = numericOf(plannedRaw);
  const challengeValue = numericOf(challengeRaw);
  // Live, so a deliberate inversion is visible before the write lands (D-151).
  const inverted =
    plannedValue !== null && challengeValue !== null && challengeValue > plannedValue;

  const tint = errored
    ? "bg-warn/10"
    : inverted
      ? "bg-challenge/10"
      : present
        ? ""
        : "bg-muted/40";

  const inputBase =
    "w-16 rounded border bg-transparent px-1 py-0.5 text-right tabular-nums " +
    "focus:outline-none focus:ring-2 focus:ring-plan/40 disabled:opacity-50";

  function fieldClass(field: PlanField, tone: string): string {
    const message = draft?.fieldErrors[field];
    return `${inputBase} ${tone} ${
      message === undefined ? "border-transparent hover:border-border" : "border-warn"
    }`;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      // Blurring runs the container's commit path, so Enter and Tab behave the same.
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onRevert();
    }
  }

  return (
    <td
      className={`px-1 py-1 align-middle ${tint}`}
      onBlur={(event) => {
        // Ignore focus moves inside the cell: 计划 -> 挑战 is one edit, not two.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onCommit();
      }}
    >
      <div className="flex flex-col gap-0.5">
        <input
          type="text"
          inputMode="decimal"
          value={plannedRaw}
          disabled={saving}
          aria-label={`${row.sectionName} ${cell.label} 计划工时`}
          aria-invalid={draft?.fieldErrors.plannedHours !== undefined}
          title={draft?.fieldErrors.plannedHours}
          className={fieldClass("plannedHours", "text-sm text-plan")}
          onChange={(event) => onEdit("plannedHours", event.target.value)}
          onKeyDown={onKeyDown}
        />
        <input
          type="text"
          inputMode="decimal"
          value={challengeRaw}
          disabled={saving}
          aria-label={`${row.sectionName} ${cell.label} 挑战工时`}
          aria-invalid={draft?.fieldErrors.challengeHours !== undefined}
          title={draft?.fieldErrors.challengeHours}
          className={fieldClass("challengeHours", "text-xs text-challenge")}
          onChange={(event) => onEdit("challengeHours", event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </td>
  );
}

/** One row of the old -> new comparison shown before the write. */
function ComparisonRow({
  label,
  before,
  after,
  tone,
}: {
  label: string;
  before: string;
  after: string;
  tone: string;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        <span className="text-muted-foreground">{toComparison(before)}</span>
        <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
          →
        </span>
        <span className={`font-medium ${tone}`}>{toComparison(after)}</span>
      </dd>
    </div>
  );
}

export function PlanGridEditor({
  grid,
  fiscalYearId,
}: {
  grid: PlanGrid;
  fiscalYearId: string;
}): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, CellDraft>>({});
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reasonFieldId = useId();
  const reasonErrorId = useId();

  /**
   * Ensures a draft exists for a cell and applies `mutate` to it.
   *
   * The initial draft is seeded from props on first touch rather than for all 288
   * cells up front, so an untouched grid holds no client state and a server refresh
   * flows straight through to the inputs.
   */
  const patch = useCallback(
    (key: string, cell: PlanGridCell, mutate: (draft: CellDraft) => CellDraft): void => {
      setDrafts((previous) => {
        const current = previous[key] ?? draftFromCell(cell);
        return { ...previous, [key]: mutate(current) };
      });
    },
    [],
  );

  const handleEdit = useCallback(
    (key: string, cell: PlanGridCell, field: PlanField, value: string): void => {
      patch(key, cell, (draft) => {
        // Delete rather than assign undefined: an `undefined`-valued key still counts
        // in Object.keys(), which is how "does this cell have complaints" is decided.
        const remaining = { ...draft.fieldErrors };
        delete remaining[field];
        return {
          ...draft,
          [field === "plannedHours" ? "plannedRaw" : "challengeRaw"]: value,
          // Typing clears this field's complaint; the other field keeps its own.
          status: "idle",
          fieldErrors: remaining,
        };
      });
    },
    [patch],
  );

  const handleRevert = useCallback(
    (key: string, cell: PlanGridCell): void => {
      patch(key, cell, (draft) => ({
        ...draft,
        plannedRaw: draft.committedPlanned,
        challengeRaw: draft.committedChallenge,
        status: "idle",
        fieldErrors: {},
      }));
    },
    [patch],
  );

  /**
   * Leaving a changed cell asks for confirmation instead of writing (D-174).
   *
   * Unchanged cells never open the dialog: tabbing across a row the operator is only
   * reading must stay free, and there is nothing to justify.
   */
  const requestCommit = useCallback(
    (
      key: string,
      row: PlanGridRow,
      cell: PlanGridCell,
      // The cell passes its own draft rather than this reading it back out of state:
      // a keystroke re-renders before the blur fires, so the prop is current, and
      // reading state here would need a ref to escape the closure.
      submitted: CellDraft | undefined,
    ): void => {
      if (submitted === undefined || submitted.status === "saving") {
        // Untouched cell, or a write already in flight. Nothing to do either way.
        return;
      }
      if (
        submitted.plannedRaw === submitted.committedPlanned &&
        submitted.challengeRaw === submitted.committedChallenge
      ) {
        // Nothing changed. Clearing any stale complaint keeps a reverted cell clean.
        if (submitted.status !== "idle" || Object.keys(submitted.fieldErrors).length > 0) {
          patch(key, cell, (draft) => ({ ...draft, status: "idle", fieldErrors: {} }));
        }
        return;
      }
      if (pending !== null) {
        // The dialog itself takes focus, which blurs whatever cell the operator had
        // just clicked into. That cell is unchanged and returns above; this guard is
        // for the remaining case, so an in-flight question is never replaced silently.
        return;
      }
      setPending({ key, row, cell, submitted });
      setReason("");
      setReasonMissing(false);
    },
    [patch, pending],
  );

  /** Declining the write puts the cell back to what the database holds. */
  const cancelCommit = useCallback((): void => {
    if (pending === null) {
      return;
    }
    handleRevert(pending.key, pending.cell);
    setPending(null);
    setReason("");
    setReasonMissing(false);
  }, [handleRevert, pending]);

  const confirmCommit = useCallback(async (): Promise<void> => {
    if (pending === null) {
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      // The button stays enabled rather than disabled: a disabled control announces
      // nothing about why, and the server rejects this case anyway (plans/actions.ts).
      setReasonMissing(true);
      reasonRef.current?.focus();
      return;
    }

    const { key, row, cell, submitted } = pending;
    setPending(null);
    setReason("");
    setReasonMissing(false);

    patch(key, cell, (draft) => ({ ...draft, status: "saving", fieldErrors: {} }));

    const result = await savePlanCell({
      sectionId: row.sectionId,
      fiscalYearId,
      month: cell.month,
      plannedRaw: submitted.plannedRaw,
      challengeRaw: submitted.challengeRaw,
      reason: trimmedReason,
    });

    if (result.ok) {
      setDrafts((previous) => {
        const draft = previous[key];
        if (draft === undefined) {
          return previous;
        }
        return {
          ...previous,
          [key]: {
            ...draft,
            committedPlanned: submitted.plannedRaw,
            committedChallenge: submitted.challengeRaw,
            status: "idle",
            fieldErrors: {},
            present: true,
          },
        };
      });
      const label = `${row.sectionName} ${cell.label}`;
      if (result.loggedChanges === 0 && result.updated) {
        toast.info(`${label} 数值未变化,未记录修改`);
      } else {
        toast.success(
          `${label} 已保存 计划 ${formatHoursValue(result.plannedHours)} / 挑战 ${formatHoursValue(
            result.challengeHours,
          )}`,
          result.inverted ? { description: "挑战高于计划,按 D-151 原样保留。" } : undefined,
        );
      }
      return;
    }

    const correctable = Object.keys(result.fieldErrors).length > 0;
    setDrafts((previous) => {
      const draft = previous[key];
      if (draft === undefined) {
        return previous;
      }
      return {
        ...previous,
        [key]: {
          ...draft,
          // A correctable input keeps what was typed - discarding it would make the
          // operator retype to see the same complaint. A failed write reverts,
          // because leaving a value on screen that is not in the database is worse.
          plannedRaw: correctable ? draft.plannedRaw : draft.committedPlanned,
          challengeRaw: correctable ? draft.challengeRaw : draft.committedChallenge,
          status: "error",
          fieldErrors: result.fieldErrors,
        },
      };
    });
    toast.error(`${row.sectionName} ${cell.label}: ${result.message}`);
  }, [fiscalYearId, patch, pending, reason]);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg bg-card ring-1 ring-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            各课分月计划工时与挑战工时,可直接编辑。每格上行为计划工时,下行为挑战工时,单位小时。
            离开格子后会弹出确认框,填写修改原因并确认才会保存;按 Esc 撤销未保存的输入。
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th
                scope="col"
                className="sticky left-0 z-20 bg-muted/40 px-3 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase whitespace-nowrap"
              >
                课
              </th>
              {grid.monthLabels.map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="px-2 py-2 text-right text-[11px] font-semibold tracking-wider text-muted-foreground tabular-nums whitespace-nowrap"
                >
                  {label}
                </th>
              ))}
              <th
                scope="col"
                className="border-l border-border px-3 py-2 text-right text-[11px] font-semibold tracking-wider text-muted-foreground uppercase whitespace-nowrap"
              >
                合计
              </th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.sectionId} className="border-b border-border last:border-0">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-card px-3 py-2 text-left align-middle text-sm font-medium whitespace-nowrap"
                >
                  {row.sectionName}
                  {row.missingMonths > 0 ? (
                    <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">
                      缺 {row.missingMonths} 月
                    </span>
                  ) : null}
                </th>
                {row.cells.map((cell) => {
                  const key = cellKey(row.sectionId, cell.month);
                  const draft = drafts[key];
                  return (
                    <GridCell
                      key={cell.month}
                      row={row}
                      cell={cell}
                      draft={draft}
                      onEdit={(field, value) => handleEdit(key, cell, field, value)}
                      onCommit={() => requestCommit(key, row, cell, draft)}
                      onRevert={() => handleRevert(key, cell)}
                    />
                  );
                })}
                {/* Totals come from the server render, so they catch up on revalidate
                    rather than being recomputed from drafts - one source of truth. */}
                <td className="border-l border-border px-3 py-1.5 text-right align-middle tabular-nums">
                  <div className="text-sm font-medium text-plan">
                    {formatHoursValue(row.plannedTotal)}
                  </div>
                  <div className="text-xs text-challenge">
                    {formatHoursValue(row.challengeTotal)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending === null ? null : (
        <AlertDialog
          open
          onOpenChange={(open) => {
            // Escape is the only route to false here - neither button is a Close part -
            // and it means the same as 取消, matching Escape inside a cell.
            if (!open) {
              cancelCommit();
            }
          }}
        >
          <AlertDialogContent initialFocus={reasonRef}>
            <AlertDialogTitle>确认修改计划工时</AlertDialogTitle>
            <AlertDialogDescription>
              {pending.row.sectionName} · {pending.cell.label}
            </AlertDialogDescription>

            <dl className="mt-3 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <ComparisonRow
                label="计划工时"
                before={pending.submitted.committedPlanned}
                after={pending.submitted.plannedRaw}
                tone="text-plan"
              />
              <ComparisonRow
                label="挑战工时"
                before={pending.submitted.committedChallenge}
                after={pending.submitted.challengeRaw}
                tone="text-challenge"
              />
            </dl>

            <div className="mt-4 space-y-1.5">
              <label htmlFor={reasonFieldId} className="block text-sm font-medium">
                修改原因(必填,记入修改履历)
              </label>
              <textarea
                id={reasonFieldId}
                ref={reasonRef}
                rows={3}
                value={reason}
                maxLength={REASON_MAX_LENGTH}
                aria-invalid={reasonMissing}
                aria-describedby={reasonMissing ? reasonErrorId : undefined}
                placeholder="例如:年中预算调整,追加 A 线增产工时。"
                className={`w-full resize-y rounded border bg-transparent px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-plan/30 ${
                  reasonMissing ? "border-warn" : "border-border focus:border-plan"
                }`}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (reasonMissing && event.target.value.trim() !== "") {
                    setReasonMissing(false);
                  }
                }}
              />
              {reasonMissing ? (
                <p id={reasonErrorId} role="alert" className="text-xs text-warn">
                  请填写修改原因后再确认。
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  最长 {REASON_MAX_LENGTH} 字,会随本次修改一并写入履历。
                </p>
              )}
            </div>

            <AlertDialogFooter>
              <Button variant="outline" onClick={cancelCommit}>
                取消
              </Button>
              <Button onClick={() => void confirmCommit()}>确认保存</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
