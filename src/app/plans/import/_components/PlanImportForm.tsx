/**
 * Client-side driver for the two-step Excel import (D-142).
 *
 * Holds the selected file, calls `previewPlanImport`, renders what would be written,
 * then calls `commitPlanImport` with the SAME file. The file object is kept in state
 * rather than uploaded once and referenced by id - see the actions module for why the
 * bytes must be resubmitted.
 *
 * Native `<input type="file">` rather than the `ui/input.tsx` primitive. That primitive
 * wraps Base UI's Input, whose value handling is built for text fields; a file input's
 * value is read-only by browser policy and its own `file:` pseudo-element styling is what
 * actually needs to be reached here. The attendance upload form makes the same call.
 *
 * The confirm-overwrite checkbox is a convenience, not a guard. The server refuses an
 * overwrite without it regardless of what this component sends.
 */
"use client";

import {
  Fragment,
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import { toast } from "sonner";

import {
  commitPlanImport,
  previewPlanImport,
  type PlanImportCommitSummary,
  type PlanImportPreview,
} from "../actions";
import { Button } from "@/components/ui/button";
import { formatHoursRounded } from "@/lib/format";
import type { ImportProblem } from "@/lib/plans/import";

/** Months in fiscal order for the preview header. Index 0 = April (DB month 1). */
const MONTH_LABELS: readonly string[] = [
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
  "1月",
  "2月",
  "3月",
];

/** Matches the server ceiling so an oversized pick is reported without a round-trip. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const REASON_MAX_LENGTH = 200;

interface FiscalYearOption {
  id: string;
  name: string;
  isCurrent: boolean;
}

/** Renders the accumulated problem list. */
function ProblemList({
  problems,
}: {
  problems: readonly ImportProblem[];
}): ReactElement | null {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto text-sm">
      {problems.map((problem, index) => (
        <li
          key={`${problem.where ?? "general"}-${String(index)}`}
          className="flex gap-2 leading-relaxed"
        >
          {problem.where === null ? null : (
            <code className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-xs text-warn">
              {problem.where}
            </code>
          )}
          <span className="text-foreground">{problem.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** The preview table: one row per section, 12 month columns, planned over challenge. */
function PreviewTable({ preview }: { preview: PlanImportPreview }): ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          {preview.fiscalYearName} 计划工时导入预览,每个课分计划与挑战两行
        </caption>
        <thead>
          <tr className="bg-muted/60">
            <th scope="col" className="sticky left-0 z-10 bg-muted/60 px-3 py-2 text-left font-semibold">
              部门 / 课
            </th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              分类
            </th>
            {MONTH_LABELS.map((label) => (
              <th key={label} scope="col" className="px-2 py-2 text-right font-semibold tabular-nums">
                {label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              合计
            </th>
          </tr>
        </thead>
        <tbody>
          {preview.sections.map((section) => (
            <Fragment key={`${section.dept}-${section.section}`}>
              <tr className="border-t border-border">
                <th
                  scope="rowgroup"
                  rowSpan={2}
                  className="sticky left-0 z-10 bg-card px-3 py-2 text-left align-middle font-medium"
                >
                  <span className="block text-xs text-muted-foreground">{section.dept}</span>
                  <span className="block">{section.section}</span>
                </th>
                <th scope="row" className="px-3 py-1.5 text-left text-xs font-medium text-plan">
                  计划
                </th>
                {section.planned.map((value, index) => (
                  <td
                    key={`p-${MONTH_LABELS[index] ?? String(index)}`}
                    className="px-2 py-1.5 text-right tabular-nums"
                  >
                    {formatHoursRounded(value)}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                  {formatHoursRounded(section.plannedTotal)}
                </td>
              </tr>
              <tr className="bg-muted/20">
                <th scope="row" className="px-3 py-1.5 text-left text-xs font-medium text-challenge">
                  挑战
                </th>
                {section.challenge.map((value, index) => (
                  <td
                    key={`c-${MONTH_LABELS[index] ?? String(index)}`}
                    className={`px-2 py-1.5 text-right tabular-nums ${
                      value > (section.planned[index] ?? 0) ? "text-challenge" : ""
                    }`}
                  >
                    {formatHoursRounded(value)}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                  {formatHoursRounded(section.challengeTotal)}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlanImportForm({
  fiscalYears,
  defaultFiscalYearId,
}: {
  fiscalYears: readonly FiscalYearOption[];
  defaultFiscalYearId: string;
}): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reasonInputRef = useRef<HTMLInputElement>(null);
  const fileFieldId = useId();
  const yearFieldId = useId();
  const reasonFieldId = useId();
  const reasonErrorId = useId();

  const [fiscalYearId, setFiscalYearId] = useState(defaultFiscalYearId);
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [busy, setBusy] = useState<"idle" | "preview" | "commit">("idle");
  const [preview, setPreview] = useState<PlanImportPreview | null>(null);
  const [summary, setSummary] = useState<PlanImportCommitSummary | null>(null);
  const [error, setError] = useState<{ message: string; problems: readonly ImportProblem[] } | null>(
    null,
  );

  /** Any change to the inputs invalidates a preview that was built from the old ones. */
  const resetResults = useCallback(() => {
    setPreview(null);
    setSummary(null);
    setError(null);
    setConfirmOverwrite(false);
  }, []);

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0] ?? null;
      resetResults();
      if (picked !== null && picked.size > MAX_UPLOAD_BYTES) {
        setFile(null);
        setError({
          message: `文件超过 ${String(MAX_UPLOAD_BYTES / (1024 * 1024))}MB 上限,请确认选择的文件正确。`,
          problems: [],
        });
        return;
      }
      setFile(picked);
    },
    [resetResults],
  );

  const buildFormData = useCallback((): FormData | null => {
    if (file === null) {
      return null;
    }
    const formData = new FormData();
    formData.set("fiscalYearId", fiscalYearId);
    formData.set("file", file);
    // Always set, even when blank: the commit action decides whether an empty reason is
    // acceptable, and omitting the key would let a stale build look like a stale server.
    formData.set("reason", reason.trim());
    return formData;
  }, [file, fiscalYearId, reason]);

  const onPreview = useCallback(async () => {
    const formData = buildFormData();
    if (formData === null) {
      setError({ message: "请先选择要导入的 Excel 文件。", problems: [] });
      return;
    }
    setBusy("preview");
    setSummary(null);
    setError(null);
    try {
      const result = await previewPlanImport(formData);
      if (result.ok) {
        setPreview(result.preview);
        toast.success(
          `校验通过:${String(result.preview.sections.length)} 个课,${String(result.preview.rowCount)} 行待写入`,
        );
      } else {
        setPreview(null);
        setError({ message: result.message, problems: result.problems });
        toast.error("文件校验未通过,未写入任何数据");
      }
    } catch (caught) {
      console.error("[PlanImportForm] preview failed", caught);
      setPreview(null);
      setError({ message: "校验请求失败,请重试。", problems: [] });
    } finally {
      setBusy("idle");
    }
  }, [buildFormData]);

  const onCommit = useCallback(async () => {
    const formData = buildFormData();
    if (formData === null || preview === null) {
      setError({ message: "请先完成校验预览。", problems: [] });
      return;
    }
    if (reason.trim() === "") {
      // D-174 makes this required. Checked here rather than at preview time, because a
      // preview writes nothing and logs nothing - there is not yet a change to justify.
      setReasonMissing(true);
      setError({ message: "请填写导入说明后再导入。", problems: [] });
      reasonInputRef.current?.focus();
      return;
    }
    if (confirmOverwrite) {
      formData.set("confirmOverwrite", "yes");
    }
    setBusy("commit");
    setError(null);
    try {
      const result = await commitPlanImport(formData);
      if (result.ok) {
        setSummary(result.summary);
        setPreview(null);
        setFile(null);
        setReason("");
        setReasonMissing(false);
        setConfirmOverwrite(false);
        if (fileInputRef.current !== null) {
          fileInputRef.current.value = "";
        }
        toast.success(
          `导入完成:写入 ${String(result.summary.rowsWritten)} 行,留痕 ${String(result.summary.loggedChanges)} 条`,
        );
      } else {
        setError({ message: result.message, problems: result.problems });
        toast.error("导入未执行,数据保持原状");
      }
    } catch (caught) {
      console.error("[PlanImportForm] commit failed", caught);
      setError({ message: "导入请求失败,请重试。", problems: [] });
    } finally {
      setBusy("idle");
    }
  }, [buildFormData, confirmOverwrite, preview, reason]);

  const overwriteBlocked =
    preview !== null && preview.existingRowCount > 0 && !confirmOverwrite;

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-lg bg-card p-5 ring-1 ring-border">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={yearFieldId} className="block text-sm font-medium">
              导入到财年
            </label>
            <select
              id={yearFieldId}
              value={fiscalYearId}
              disabled={busy !== "idle"}
              onChange={(event) => {
                setFiscalYearId(event.target.value);
                resetResults();
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {fiscalYears.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                  {year.isCurrent ? "(当前)" : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Excel 不包含财年信息,由此处指定(D-151)。
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fileFieldId} className="block text-sm font-medium">
              计划工时 Excel(.xlsx)
            </label>
            <input
              ref={fileInputRef}
              id={fileFieldId}
              type="file"
              accept=".xlsx"
              disabled={busy !== "idle"}
              onChange={onFileChange}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
            <p className="text-xs text-muted-foreground">
              固定 15 列:部门 / 课名 / 目标工时分类 / 4月~3月,每课 2 行(计划、挑战)。
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={reasonFieldId} className="block text-sm font-medium">
            导入说明(必填,记入修改履历)
          </label>
          <input
            id={reasonFieldId}
            ref={reasonInputRef}
            type="text"
            value={reason}
            maxLength={REASON_MAX_LENGTH}
            disabled={busy !== "idle"}
            required
            aria-invalid={reasonMissing}
            aria-describedby={reasonMissing ? reasonErrorId : undefined}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonMissing && event.target.value.trim() !== "") {
                setReasonMissing(false);
              }
            }}
            placeholder="例如:年度预算下发第 2 版"
            className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
              reasonMissing ? "border-warn" : "border-border"
            }`}
          />
          {reasonMissing ? (
            <p id={reasonErrorId} role="alert" className="text-xs text-warn">
              请填写导入说明后再导入。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              校验预览不需要填写,正式导入前必须填写,会写入每条修改履历。
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => {
              void onPreview();
            }}
            disabled={busy !== "idle" || file === null}
          >
            {busy === "preview" ? "校验中…" : "校验并预览"}
          </Button>
          {file === null ? (
            <span className="text-xs text-muted-foreground">尚未选择文件</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              已选择 {file.name}({(file.size / 1024).toFixed(1)}KB)
            </span>
          )}
        </div>
      </section>

      {error === null ? null : (
        <section
          role="alert"
          className="rounded-lg bg-warn/10 p-5 ring-1 ring-warn/40"
        >
          <h2 className="font-heading text-base font-semibold text-foreground">
            {error.message}
          </h2>
          <ProblemList problems={error.problems} />
        </section>
      )}

      {summary === null ? null : (
        <section className="space-y-2 rounded-lg bg-plan/10 p-5 ring-1 ring-plan/40">
          <h2 className="font-heading text-base font-semibold">
            {summary.fiscalYearName} 导入完成
          </h2>
          <p className="text-sm text-foreground">
            写入 {summary.rowsWritten} 行(新增 {summary.created},覆盖 {summary.updated});
            按 D-143 记录修改履历 {summary.loggedChanges} 条。
          </p>
          {summary.challengeWarning === null ? null : (
            <p className="text-sm text-muted-foreground">{summary.challengeWarning}</p>
          )}
          <p className="text-xs text-muted-foreground">
            可前往「计划工时录入」页确认结果。
          </p>
        </section>
      )}

      {preview === null ? null : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-lg font-semibold">
                预览:{preview.fiscalYearName}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.sections.length} 个课 × 12 个月 = {preview.rowCount} 行待写入。
                以下数值尚未入库。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => {
                  void onCommit();
                }}
                disabled={busy !== "idle" || overwriteBlocked}
              >
                {busy === "commit" ? "写入中…" : "确认导入"}
              </Button>
            </div>
          </div>

          {preview.existingRowCount > 0 ? (
            <div className="space-y-2 rounded-lg bg-warn/10 p-4 ring-1 ring-warn/40">
              <p className="text-sm font-medium text-foreground">
                财年 {preview.fiscalYearName} 已有 {preview.existingRowCount} 条计划数据,
                本次导入会覆盖它们。
              </p>
              <p className="text-xs text-muted-foreground">
                覆盖为整体事务:全部成功或全部不写入。每个发生变化的数值都会记入修改履历(D-143),
                数值未变的格子不会产生履历。
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmOverwrite}
                  disabled={busy !== "idle"}
                  onChange={(event) => {
                    setConfirmOverwrite(event.target.checked);
                  }}
                  className="size-4 rounded border-border"
                />
                我确认覆盖该财年现有计划数据
              </label>
            </div>
          ) : null}

          {preview.challengeWarning === null ? null : (
            <div className="rounded-lg bg-challenge/10 px-4 py-3 text-sm text-foreground ring-1 ring-challenge/30">
              {preview.challengeWarning}
            </div>
          )}

          <PreviewTable preview={preview} />
        </section>
      )}
    </div>
  );
}
