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
// D-143 leaves "does an edit need a confirmation dialog" open and assumes yes for v1.
// This screen does not show one, on purpose: there is no dialog primitive in
// components/ui, and the property a dialog protects here is reversibility, which the
// design already provides three ways - the cell is disabled while in flight, a failed
// write reverts the input and reports why, and every successful write is both logged
// (D-143) and immediately re-editable. A modal on each of 288 cells would cost an
// entry session far more than it protects. Worth revisiting if the audience widens
// beyond the 1-2 administrators D-142 assumes.
//
// The reason field D-143 calls optional is collected once per session above the grid
// rather than per cell, which is the affordance a batch entry session actually wants.

import { useCallback, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { savePlanCell } from "../actions";
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

export function PlanGridEditor({
  grid,
  fiscalYearId,
}: {
  grid: PlanGrid;
  fiscalYearId: string;
}): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, CellDraft>>({});
  const [reason, setReason] = useState("");

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

  const handleCommit = useCallback(
    async (
      key: string,
      row: PlanGridRow,
      cell: PlanGridCell,
      // The cell passes its own draft rather than this reading it back out of state:
      // a keystroke re-renders before the blur fires, so the prop is current, and
      // reading state here would need a ref to escape the closure.
      submitted: CellDraft | undefined,
    ): Promise<void> => {
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

      patch(key, cell, (draft) => ({ ...draft, status: "saving", fieldErrors: {} }));

      const result = await savePlanCell({
        sectionId: row.sectionId,
        fiscalYearId,
        month: cell.month,
        plannedRaw: submitted.plannedRaw,
        challengeRaw: submitted.challengeRaw,
        reason: reason.trim() === "" ? null : reason.trim(),
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
    },
    [fiscalYearId, patch, reason],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-card px-4 py-3 ring-1 ring-border">
        <label
          htmlFor="plan-edit-reason"
          className="text-xs font-medium whitespace-nowrap text-muted-foreground"
        >
          修改原因(可选)
        </label>
        <input
          id="plan-edit-reason"
          type="text"
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          placeholder="例如:年中预算调整。填写后本次会话内的每次修改都会记入留痕。"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm focus:border-plan focus:outline-none focus:ring-2 focus:ring-plan/30"
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      <div className="overflow-x-auto rounded-lg bg-card ring-1 ring-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            各课分月计划工时与挑战工时,可直接编辑。每格上行为计划工时,下行为挑战工时,单位小时。
            离开格子即保存,按 Esc 撤销未保存的输入。
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
                      onCommit={() => void handleCommit(key, row, cell, draft)}
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
    </div>
  );
}
