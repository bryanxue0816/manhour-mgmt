/**
 * Client-side driver for the two-step attendance upload (D-170).
 *
 * Holds the selected files, calls `previewAttendanceImport`, renders the per-file verdict,
 * then calls `commitAttendanceImport` with the SAME files. The File objects stay in state
 * rather than being uploaded once and referenced by id - see the actions module for why the
 * bytes must be resubmitted.
 *
 * MULTIPLE FILES, ONE VERDICT EACH. A Monday upload carries the weekend, so the results are
 * a list and one bad file never hides what the good ones did. Nothing here aggregates the
 * statuses into a single green/red for the batch: "2 of 3 succeeded" is the fact, and
 * collapsing it would be the one summary an operator cannot act on.
 *
 * Native `<input type="file">` rather than the `ui/input.tsx` primitive, for the same
 * reason PlanImportForm uses one: Base UI's Input manages `value`, which a file input
 * cannot have, and the `file:` pseudo-element is what needs styling here.
 *
 * The 允许重新导入 checkbox is a convenience, not a guard. The server refuses a re-import
 * without it regardless of what this component sends.
 */
"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import { toast } from "sonner";

import {
  commitAttendanceImport,
  previewAttendanceImport,
  type AttendanceCommitSummary,
  type AttendancePreview,
} from "../actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
} from "@/lib/attendance/upload-guard";
import type { ImportStatus } from "@/lib/db/types";

/**
 * The ceilings are imported, not restated. upload-guard.ts is deliberately prisma-free and
 * fs-free precisely so both sides can share it: checking the pick here means an oversized
 * selection is reported without first uploading the bytes that are about to be refused,
 * and importing the constant means that message can never drift from what the server
 * enforces. The server re-checks all three regardless - this is a courtesy, not a gate.
 */

/** What the two request phases look like to the UI. */
type Busy = "idle" | "preview" | "commit";

/**
 * Colour and wording per status, following the convention /actuals already established:
 * a good outcome is NEUTRAL, not green, and only a problem gets colour. The brand greens
 * and reds are spoken for (--challenge is 挑战工时, --actual is 实绩工时) and borrowing
 * one here would make the legend on the dashboard mean two different things.
 *
 * FAILED is split from PARTIAL, which /actuals collapses together: there both are just
 * "the numbers may be stale", but here the operator is deciding whether to re-upload a
 * specific file, and "nothing was written" is a different action from "some rows landed".
 *
 * Every dot is paired with its label. A colour alone says nothing to a screen reader and
 * little to a colour-blind operator.
 */
const STATUS_STYLE: Readonly<Record<ImportStatus, { dot: string; label: string }>> = {
  SUCCESS: { dot: "bg-muted-foreground/50", label: "成功" },
  PARTIAL: { dot: "bg-warn", label: "部分成功" },
  FAILED: { dot: "bg-destructive", label: "失败" },
};

function StatusTag({ status }: { status: ImportStatus }): ReactElement {
  const style = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

/** Files the guard refused outright. They were never parsed and nothing was written. */
function RejectedList({
  rejected,
}: {
  rejected: readonly { fileName: string; message: string }[];
}): ReactElement | null {
  if (rejected.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-lg bg-warn/10 p-4 ring-1 ring-warn/40">
      <p className="text-sm font-medium text-foreground">
        {rejected.length} 个文件未被接受，已跳过（其余文件不受影响）
      </p>
      <ul className="space-y-1.5 text-sm text-foreground">
        {rejected.map((entry) => (
          <li key={entry.fileName} className="leading-relaxed">
            {entry.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Human-readable date range for one file's 出勤日期 set. */
function describeWorkDates(workDates: readonly string[]): string {
  if (workDates.length === 0) {
    return "—";
  }
  const first = workDates[0] ?? "";
  const last = workDates[workDates.length - 1] ?? "";
  return first === last ? first : `${first} ~ ${last}`;
}

export function AttendanceImportForm(): ReactElement {
  const fileFieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<readonly File[]>([]);
  const [allowReimport, setAllowReimport] = useState(false);
  const [busy, setBusy] = useState<Busy>("idle");
  const [preview, setPreview] = useState<AttendancePreview | null>(null);
  const [summary, setSummary] = useState<AttendanceCommitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Any change to the selection invalidates a preview built from the old bytes. */
  const resetResults = useCallback(() => {
    setPreview(null);
    setSummary(null);
    setError(null);
    setAllowReimport(false);
  }, []);

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      resetResults();

      if (picked.length > MAX_FILE_COUNT) {
        setFiles([]);
        setError(
          `一次最多上传 ${String(MAX_FILE_COUNT)} 个文件，本次选择了 ` +
            `${String(picked.length)} 个。请分批上传。`,
        );
        return;
      }
      const oversized = picked.find((file) => file.size > MAX_FILE_BYTES);
      if (oversized !== undefined) {
        setFiles([]);
        setError(
          `${oversized.name}：${(oversized.size / (1024 * 1024)).toFixed(1)}MB 超过单文件 ` +
            `${String(MAX_FILE_BYTES / (1024 * 1024))}MB 上限，请确认选对了文件。`,
        );
        return;
      }
      const totalBytes = picked.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_BATCH_BYTES) {
        setFiles([]);
        setError(
          `选择的 ${String(picked.length)} 个文件合计 ` +
            `${(totalBytes / (1024 * 1024)).toFixed(1)}MB，超过单次 ` +
            `${String(MAX_BATCH_BYTES / (1024 * 1024))}MB 上限。请减少文件数后重试。`,
        );
        return;
      }
      setFiles(picked);
    },
    [resetResults],
  );

  const buildFormData = useCallback((): FormData | null => {
    if (files.length === 0) {
      return null;
    }
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    return formData;
  }, [files]);

  const onPreview = useCallback(async () => {
    const formData = buildFormData();
    if (formData === null) {
      setError("请先选择要导入的考勤文件。");
      return;
    }
    setBusy("preview");
    setSummary(null);
    setError(null);
    try {
      const result = await previewAttendanceImport(formData);
      if (result.ok) {
        setPreview(result.preview);
        const rows = result.preview.files.reduce((sum, file) => sum + file.rowCount, 0);
        toast.success(
          `已检查 ${String(result.preview.files.length)} 个文件，共 ${String(rows)} 行待写入`,
        );
      } else {
        setPreview(null);
        setError(result.message);
        toast.error("文件检查未通过，未写入任何数据");
      }
    } catch (caught) {
      console.error("[AttendanceImportForm] preview failed", caught);
      setPreview(null);
      setError("检查请求失败，请重试。");
    } finally {
      setBusy("idle");
    }
  }, [buildFormData]);

  const onCommit = useCallback(async () => {
    const formData = buildFormData();
    if (formData === null || preview === null) {
      setError("请先完成检查预览。");
      return;
    }
    if (allowReimport) {
      formData.set("allowReimport", "yes");
    }
    setBusy("commit");
    setError(null);
    try {
      const result = await commitAttendanceImport(formData);
      if (result.ok) {
        setSummary(result.summary);
        setPreview(null);
        setFiles([]);
        setAllowReimport(false);
        if (fileInputRef.current !== null) {
          fileInputRef.current.value = "";
        }
        if (result.summary.succeeded === result.summary.files.length) {
          toast.success(
            `导入完成：${String(result.summary.files.length)} 个文件，` +
              `写入 ${String(result.summary.rowsStored)} 行`,
          );
        } else {
          toast.warning(
            `导入部分完成：${String(result.summary.succeeded)}/` +
              `${String(result.summary.files.length)} 个文件成功，请查看下方明细`,
          );
        }
      } else {
        setError(result.message);
        toast.error("导入未执行，数据保持原状");
      }
    } catch (caught) {
      console.error("[AttendanceImportForm] commit failed", caught);
      setError("导入请求失败，请重试。");
    } finally {
      setBusy("idle");
    }
  }, [allowReimport, buildFormData, preview]);

  const reimportBlocked =
    preview !== null && preview.needsReimportConfirmation && !allowReimport;

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-lg bg-card p-5 ring-1 ring-border">
        <div className="space-y-1.5">
          <label htmlFor={fileFieldId} className="block text-sm font-medium">
            日考勤数据文件（.xls / .xlsx，可多选）
          </label>
          <input
            ref={fileInputRef}
            id={fileFieldId}
            type="file"
            multiple
            accept=".xls,.xlsx"
            disabled={busy !== "idle"}
            onChange={onFileChange}
            aria-invalid={error !== null ? true : undefined}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-[color,box-shadow] file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
          />
          <p className="text-xs text-muted-foreground">
            一次最多 {MAX_FILE_COUNT} 个文件。周一可以把周六、周日、周一的报表一起选上，
            每个文件单独判定、单独入库，其中一个有问题不会影响其余文件。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => {
              void onPreview();
            }}
            disabled={busy !== "idle" || files.length === 0}
          >
            {busy === "preview" ? "检查中…" : "检查并预览"}
          </Button>
          {files.length === 0 ? (
            <span className="text-xs text-muted-foreground">尚未选择文件</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              已选择 {files.length} 个文件（
              {(files.reduce((sum, file) => sum + file.size, 0) / 1024).toFixed(0)}KB）
            </span>
          )}
        </div>
      </section>

      {error === null ? null : (
        <section role="alert" className="rounded-lg bg-warn/10 p-5 ring-1 ring-warn/40">
          <h2 className="font-heading text-base font-semibold text-foreground">{error}</h2>
        </section>
      )}

      {summary === null ? null : (
        <section className="space-y-4">
          <div>
            <h2 className="font-heading text-lg font-semibold">导入结果</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {summary.succeeded}/{summary.files.length} 个文件成功，共写入{" "}
              {summary.rowsStored} 行。可前往「实绩工时」页确认结果。
            </p>
          </div>
          <RejectedList rejected={summary.rejected} />
          {summary.files.length === 0 ? null : (
            <ul className="space-y-2">
              {summary.files.map((file) => (
                <li
                  key={file.fileName}
                  className="space-y-1 rounded-lg bg-card p-4 ring-1 ring-border"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-medium">{file.fileName}</span>
                    <StatusTag status={file.status} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {file.isRestDay
                      ? "休日报表：无员工数据行，已按 0 行记录"
                      : `写入 ${String(file.rowsStored)} 行`}
                    {file.monthLabels.length === 0
                      ? ""
                      : ` · 重算月份 ${file.monthLabels.join("、")}`}
                  </p>
                  {file.message === null ? null : (
                    <p className="text-sm text-foreground">{file.message}</p>
                  )}
                  {file.logged ? null : (
                    <p className="text-sm text-destructive">
                      导入日志写入失败：本次结果没有进入审计记录，请联系管理员核对。
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {preview === null ? null : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-lg font-semibold">
                预览：{preview.files.length} 个文件
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                以下为逐文件判定结果，尚未写入任何数据。确认后每个文件按各自结果入库。
              </p>
            </div>
            <Button
              type="button"
              onClick={() => {
                void onCommit();
              }}
              disabled={busy !== "idle" || reimportBlocked}
            >
              {busy === "commit" ? "写入中…" : "确认导入"}
            </Button>
          </div>

          <RejectedList rejected={preview.rejected} />

          {preview.needsReimportConfirmation ? (
            <div className="space-y-2 rounded-lg bg-warn/10 p-4 ring-1 ring-warn/40">
              <p className="text-sm font-medium text-foreground">
                其中有文件名此前已成功导入过，重新导入会用新文件覆盖对应月份的实绩数据。
              </p>
              <p className="text-xs text-muted-foreground">
                若该月份的数据被人工修正过，覆盖会丢弃这些修正。确认无误再勾选。
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={allowReimport}
                  disabled={busy !== "idle"}
                  aria-label="允许重新导入已成功导入过的文件"
                  onCheckedChange={(next) => {
                    setAllowReimport(next === true);
                  }}
                />
                允许重新导入并覆盖对应月份数据
              </label>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg ring-1 ring-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                逐文件导入预览，含判定状态、待写入行数、出勤日期范围与影响月份
              </caption>
              <thead>
                <tr className="bg-muted/60">
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    文件
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    判定
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    行数
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    出勤日期
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    影响月份
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((file) => (
                  <tr key={file.fileName} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      <span className="block">{file.fileName}</span>
                      {file.alreadyImported ? (
                        <span className="mt-0.5 block text-xs text-warn">已导入过</span>
                      ) : null}
                      {file.message === null ? null : (
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {file.message}
                        </span>
                      )}
                    </th>
                    <td className="px-3 py-2">
                      <StatusTag status={file.status} />
                      {file.isRestDay ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          休日报表
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{file.rowCount}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {describeWorkDates(file.workDates)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {file.monthLabels.length === 0 ? "—" : file.monthLabels.join("、")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
