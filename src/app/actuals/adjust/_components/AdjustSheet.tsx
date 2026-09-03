"use client";

// 人工统计 vs 系统实绩 comparison sheet (D-233).
//
// What the operator types is the UNSIGNED hand tally, never a difference. Letting them type
// `-45` would mean the screen accepts a sign it cannot check: a mistyped `45` and a mistyped
// `-45` are both plausible numbers, and only the system knows which one the arithmetic
// supports. So the field takes the tally, and 差额 is derived and read-only.
//
// The live 差额 column is computed with evaluateDraftRow - the SAME pure function the Server
// Action re-runs on submit. That is the point of the import: a second client-side
// implementation would be free to disagree with the server about what gets written, and the
// disagreement would surface as "the preview said +50 but the slip says +5".
//
// Three gates stand between a keystroke and a row in the database, because
// `createActualAdjustmentsBulk` uses createMany against a table with NO unique key on
// (課, 月) - a batch submitted twice is stored twice, and nothing downstream notices:
//
//   1. A confirmation dialog lists every slip that would be filed, before any of them are.
//   2. Both the submit and the confirm button are disabled while a submission is in flight,
//      so a double-click cannot become two batches.
//   3. Drafts are cleared on success, so the button has nothing left to re-fire and the
//      refreshed 已有调整 column shows what just landed.
//
// A blank field and a typed `0` are deliberately different things, and the difference is
// carried in the DOM (`data-delta-kind`) as well as visually: blank means "this 課 was not
// tallied", `0` means "the tally is zero". Reading one as the other would file a slip
// zeroing every 課 the operator never looked at.

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";

import {
  submitActualAdjustments,
  type RiskyAdjustRow,
  type StaleAdjustRow,
} from "../actions";
import {
  evaluateDraftRow,
  planAdjustment,
  type AdjustDraftRow,
  type AdjustPlan,
} from "@/lib/attendance/adjust-draft";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatHoursValue, formatSignedHours } from "@/lib/format";

/** Matches ADJUST_REASON_MAX_LENGTH in ../actions - the server refuses anything longer. */
const REASON_MAX_LENGTH = 120;

interface AdjustSheetProps {
  readonly fiscalYear: number;
  readonly month: number;
  readonly monthLabel: string;
  readonly rows: readonly AdjustDraftRow[];
  readonly baseTotal: string;
}

/** What the last submission came back with, for the banner above the table. */
type SheetOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "written";
      readonly written: number;
      readonly unchangedCount: number;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "matched"; readonly unchangedCount: number }
  | { readonly kind: "stale"; readonly rows: readonly StaleAdjustRow[] }
  | { readonly kind: "error"; readonly message: string };

export function AdjustSheet({
  fiscalYear,
  month,
  monthLabel,
  rows,
  baseTotal,
}: AdjustSheetProps): ReactElement {
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<SheetOutcome>({ kind: "none" });
  const [confirming, setConfirming] = useState(false);
  /** Server-flagged large corrections, shown inside the dialog once it has said so. */
  const [serverRisky, setServerRisky] = useState<readonly RiskyAdjustRow[]>([]);

  // Recomputed from the drafts on every keystroke rather than stored: a cached plan and a
  // changed field are one render apart, and the stale copy would be the one on screen.
  const plan: AdjustPlan = useMemo(
    () => planAdjustment(rows, new Map(Object.entries(entries))),
    [rows, entries],
  );

  const onEntryChange = useCallback((sectionId: string, value: string) => {
    setEntries((previous) => ({ ...previous, [sectionId]: value }));
    // Clearing the server's per-field error as soon as the field is touched: leaving it
    // would mark a corrected field as still wrong.
    setFieldErrors((previous) => {
      if (previous[sectionId] === undefined) return previous;
      const next: Record<string, string> = {};
      for (const [key, message] of Object.entries(previous)) {
        if (key !== sectionId) next[key] = message;
      }
      return next;
    });
  }, []);

  /** Every base as the RAW number. See the note on the hidden-base drift check below. */
  const bases = useMemo(() => {
    const map: Record<string, number> = {};
    for (const row of rows) map[row.sectionId] = row.baseHours;
    return map;
  }, [rows]);

  const submit = useCallback(
    async (riskAcknowledged: boolean): Promise<void> => {
      setSubmitting(true);
      try {
        const result = await submitActualAdjustments({
          fiscalYear,
          month,
          reason,
          entries,
          // The raw numbers, NOT formatHoursValue output: that caps at one decimal, so a
          // base of 965.25 would post as 965.3 and the server would refuse a batch nobody
          // had touched.
          bases,
          riskAcknowledged,
        });

        if (result.ok) {
          setConfirming(false);
          setServerRisky([]);
          setFieldErrors({});
          if (result.written === 0) {
            setOutcome({ kind: "matched", unchangedCount: result.unchangedCount });
            toast.success(`${monthLabel} 全部一致,未登记调整单`);
            return;
          }
          // Gate 3: the drafts go, so the button cannot re-fire the same batch and the
          // table below re-renders from the server with the new 已有调整 figures.
          setEntries({});
          setReason("");
          setOutcome({
            kind: "written",
            written: result.written,
            unchangedCount: result.unchangedCount,
            warnings: result.warnings,
          });
          toast.success(`已登记 ${String(result.written)} 张调整单`);
          return;
        }

        setFieldErrors(result.fieldErrors);

        if (result.needsConfirmation.length > 0) {
          // Not an error: the server is asking. Keep the dialog open and show its list,
          // which is authoritative over the client-side one.
          setServerRisky(result.needsConfirmation);
          setConfirming(true);
          return;
        }

        setConfirming(false);
        if (result.staleRows.length > 0) {
          setOutcome({ kind: "stale", rows: result.staleRows });
          toast.error("页面数据已过期,未写入任何数据");
          return;
        }
        setOutcome({ kind: "error", message: result.message });
        toast.error(result.message);
      } finally {
        setSubmitting(false);
      }
    },
    [bases, entries, fiscalYear, month, monthLabel, reason],
  );

  const reasonMissing = reason.trim() === "";
  const nothingToSubmit = plan.writes.length === 0 && plan.unchangedCount === 0;
  const hasInvalid = plan.invalid.length > 0;

  /** Gate 1: nothing is posted straight from the table. */
  const openConfirm = useCallback(() => {
    setServerRisky([]);
    setConfirming(true);
  }, []);

  // "Checked, everything agreed" needs no confirmation dialog: gate 1 exists to stop a
  // batch being written twice, and this path writes nothing. Showing a dialog that reads
  // 「以下 0 张单据将写入」 would spend the operator's attention on an empty list, which is
  // exactly how a confirmation step stops being read.
  const isAgreementOnly = plan.writes.length === 0 && plan.unchangedCount > 0;

  const dialogRisky = serverRisky.length > 0 ? serverRisky : null;

  return (
    <>
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-heading text-base font-semibold">
              {monthLabel} 逐课对比
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              当前实绩合计 {baseTotal} H。差额 = 人工统计 − 当前实绩,由系统计算,不需要输入正负号。
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            待登记 <span className="font-mono font-medium text-foreground">{plan.writes.length}</span> 课
            · 已核对一致 <span className="font-mono">{plan.unchangedCount}</span> 课
            · 未填 <span className="font-mono">{plan.blankCount}</span> 课
          </div>
        </div>

        {outcome.kind === "stale" ? (
          <div className="border-b border-border bg-destructive/10 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">
              页面数据已过期,本次未写入任何一行。
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              下列课的当前实绩在你核对期间发生了变动(定时折算或他人登记的调整单)。
              请刷新页面,重新与人工统计核对后再提交。
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {outcome.rows.map((stale) => (
                <li key={stale.sectionName} className="font-mono tabular-nums">
                  {stale.sectionName}:页面 {formatHoursValue(stale.shown)} H → 现为{" "}
                  {stale.current === null ? "（已删除）" : `${formatHoursValue(stale.current)} H`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {outcome.kind === "written" ? (
          <div className="border-b border-border bg-actual/10 px-4 py-3 text-sm">
            <p className="font-medium">
              已登记 {outcome.written} 张调整单,另有 {outcome.unchangedCount} 课核对一致。
            </p>
            {outcome.warnings.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {outcome.warnings.map((warning) => (
                  <li key={warning}>※ {warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {outcome.kind === "matched" ? (
          <div className="border-b border-border bg-muted/40 px-4 py-3 text-sm">
            已核对 {outcome.unchangedCount} 课,与人工统计完全一致,没有需要登记的差额。
          </div>
        ) : null}

        {outcome.kind === "error" ? (
          <div className="border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {outcome.message}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              {monthLabel} 全部课的折算工时、已有调整、当前实绩与人工统计对比表
            </caption>
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-medium">部</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">课</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">折算</th>
                {/* Never collapsible: 当前实绩 = 折算 + 这一列, and an operator who cannot
                    see it cannot tell which figure the 差额 was measured from. */}
                <th scope="col" className="px-4 py-2 text-right font-medium">已有调整</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">当前实绩</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">人工统计</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">差额</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const raw = entries[row.sectionId] ?? "";
                const verdict = evaluateDraftRow(row, raw);
                const serverError = fieldErrors[row.sectionId];
                const isBad = verdict.kind === "invalid" || serverError !== undefined;
                return (
                  <tr
                    key={row.sectionId}
                    className="border-b border-border/60 hover:bg-muted/30"
                  >
                    <td className="px-4 py-1.5 text-xs text-muted-foreground">
                      {row.departmentName}
                    </td>
                    <td className="px-4 py-1.5">
                      {row.sectionName}
                      {row.isManualBaseline ? (
                        <span
                          className="ml-1.5 cursor-help text-xs text-muted-foreground"
                          title="该月实绩为人工基线导入,没有可重跑的折算"
                        >
                          ※
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {/* 尚未导入 is not 0: a month with no fold at all must not read as a
                          plant that worked zero hours. */}
                      {row.present ? formatHoursValue(row.foldHours) : "尚未导入"}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums">
                      {row.existingAdjustment === 0 ? (
                        <span className="text-muted-foreground">0.0</span>
                      ) : (
                        formatSignedHours(row.existingAdjustment)
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums font-medium">
                      {formatHoursValue(row.baseHours)}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <Input
                        // text, not number: a Chinese IME produces full-width digits, which
                        // parseManualEntry normalises but a number input silently discards.
                        type="text"
                        inputMode="decimal"
                        value={raw}
                        onChange={(event) => {
                          onEntryChange(row.sectionId, event.target.value);
                        }}
                        disabled={submitting}
                        aria-label={`${row.sectionName} 人工统计工时`}
                        aria-invalid={isBad || undefined}
                        placeholder="留空＝不调整"
                        className={
                          isBad
                            ? "h-8 w-28 text-right font-mono tabular-nums border-destructive"
                            : "h-8 w-28 text-right font-mono tabular-nums"
                        }
                      />
                    </td>
                    <td
                      // The DOM carries the distinction, not just the colour: blank and 0.0
                      // must be tellable apart by a screen reader and by a QA screenshot.
                      data-delta-kind={verdict.kind}
                      className="px-4 py-1.5 text-right font-mono tabular-nums"
                    >
                      {verdict.kind === "blank" ? (
                        <span className="text-muted-foreground/60" aria-label="未填,不调整">
                          —
                        </span>
                      ) : null}
                      {verdict.kind === "unchanged" ? (
                        <span className="text-muted-foreground" title="填入值与当前实绩一致">
                          0.0
                        </span>
                      ) : null}
                      {verdict.kind === "write" ? (
                        <span
                          className={
                            verdict.risk === null
                              ? "font-medium"
                              : "font-medium text-destructive"
                          }
                          title={verdict.risk ?? undefined}
                        >
                          {formatSignedHours(verdict.delta)}
                          {verdict.risk === null ? null : " ⚠"}
                        </span>
                      ) : null}
                      {verdict.kind === "invalid" ? (
                        <span className="text-xs font-normal text-destructive">
                          {verdict.message}
                        </span>
                      ) : null}
                      {serverError === undefined ? null : (
                        <span className="block text-xs font-normal text-destructive">
                          {serverError}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 border-t border-border px-4 py-4">
          <div>
            <label
              htmlFor="adjust-reason"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              调整原因（必填,写入每一张单据）
            </label>
            <Input
              id="adjust-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              disabled={submitting}
              maxLength={REASON_MAX_LENGTH}
              placeholder="例：与生产课人工统计核对后修正"
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              系统会在原因后自动附上算式（人工统计 X H − 当前实绩 Y H）,便于日后审计。
              剩余 {REASON_MAX_LENGTH - reason.length} 字。
            </p>
          </div>

          {plan.warnings.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {plan.warnings.map((warning) => (
                <li key={warning}>※ {warning}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {hasInvalid
                ? `有 ${plan.invalid.length} 个课的输入无法识别,请先修正。`
                : nothingToSubmit
                  ? "填入人工统计值后即可提交。只有差额不为 0 的课会登记调整单。"
                  : isAgreementOnly
                    ? `已核对 ${plan.unchangedCount} 课全部一致,提交后不会产生任何单据。`
                    : `将登记 ${plan.writes.length} 张调整单。`}
            </p>
            <Button
              type="button"
              onClick={() => {
                if (isAgreementOnly) {
                  void submit(false);
                  return;
                }
                openConfirm();
              }}
              disabled={submitting || hasInvalid || nothingToSubmit || reasonMissing}
            >
              {submitting
                ? "提交中…"
                : reasonMissing && !nothingToSubmit
                  ? "请先填写调整原因"
                  : isAgreementOnly
                    ? "确认全部一致"
                    : "核对并提交"}
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          // Not dismissible mid-flight: closing the dialog while the action is running
          // would leave the operator unsure whether the batch landed.
          if (!submitting) setConfirming(next);
        }}
      >
        <AlertDialogContent className="w-[min(40rem,calc(100vw-2rem))]">
          <AlertDialogTitle>确认登记 {monthLabel} 调整单</AlertDialogTitle>
          <AlertDialogDescription>
            以下 {plan.writes.length} 张单据将写入。留空与核对一致的课不会产生任何记录。
            该表没有唯一键,重复提交会写入两次,请确认后只提交一次。
          </AlertDialogDescription>

          {dialogRisky === null ? null : (
            <div className="mt-3 rounded-md bg-destructive/10 p-3 text-xs">
              <p className="font-medium text-destructive">
                下列课的调整幅度较大,请再核对一次人工统计值：
              </p>
              <ul className="mt-1.5 space-y-1">
                {dialogRisky.map((risky) => (
                  <li key={risky.sectionName} className="font-mono tabular-nums">
                    {risky.sectionName}：{formatHoursValue(risky.baseHours)} →{" "}
                    {formatHoursValue(risky.manualHours)}（{formatSignedHours(risky.delta)}）
                    <span className="ml-1 font-sans text-muted-foreground">{risky.risk}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <tbody>
                {plan.writes.map((write) => (
                  <tr key={write.sectionId} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1.5">{write.sectionName}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {formatHoursValue(write.baseHours)} → {formatHoursValue(write.manualHours)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums font-medium">
                      {formatSignedHours(write.hours)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setConfirming(false);
              }}
            >
              返回修改
            </Button>
            <Button
              type="button"
              // Gate 2: disabled in flight, so a double-click cannot become two batches.
              disabled={submitting}
              onClick={() => {
                // The acknowledgement is only true once the operator has SEEN the
                // server's risky list; the first pass sends false on purpose so the
                // server gets to raise it.
                void submit(dialogRisky !== null);
              }}
            >
              {submitting ? "登记中…" : `确认登记 ${plan.writes.length} 张`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
