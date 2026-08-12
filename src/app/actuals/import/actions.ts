// Server Actions for the browser attendance upload (D-170: the only routine entry point).
//
// TWO STEPS, ONE VERDICT. `previewAttendanceImport` parses the uploaded bytes and reports
// the status each file WOULD be recorded with; `commitAttendanceImport` writes them. Both
// route through classifyAttendanceParse() in lib/attendance/verdict.ts, so the status the
// operator approves is the status that lands in import_log. The only outcome a preview
// cannot foresee is a FAILED produced by the write itself.
//
// Re-parsing in step 2 is deliberate (D-159). Caching the parsed rows between the calls
// would leave "the bytes the operator approved" and "the rows that got written" connected
// only by a server-side handle; any bug or tampering there writes numbers nobody previewed
// while the audit trail records them as approved. Consequence for the client: it sends the
// same files twice, and there is no upload id in the payload.
//
// PER-FILE, NOT ATOMIC. A Monday upload carries Saturday, Sunday and Monday. Wrapping them
// in one transaction would turn "one of three files is bad" into "nothing was imported",
// which is precisely backwards for the case this page exists to serve. Each file gets its
// own verdict, its own write and its own import_log row; a bad file is reported beside the
// good ones that succeeded.

"use server";

import { revalidatePath } from "next/cache";

import {
  ingestAttendanceSource,
  inspectAttendanceSource,
  type InspectResult,
} from "@/lib/attendance/ingest";
import {
  checkUploadBatch,
  checkUploadCandidate,
  checkWorkbookSignature,
  sanitiseFileMtime,
} from "@/lib/attendance/upload-guard";
import { fiscalMonthLabel } from "@/lib/db/date";
import { hasSuccessfulImport } from "@/lib/db/import-log.repo";
import type { ImportStatus } from "@/lib/db/types";

/**
 * Every upload from this page is `manual`.
 *
 * ImportTrigger still carries `schedule` for the historical rows written before D-170
 * removed scheduling; nothing new writes that value, and it must stay in the vocabulary
 * because assertImportTrigger would throw when reading those rows back.
 */
const UPLOAD_TRIGGER = "manual" as const;

/** One file's line in the preview table. */
export interface AttendancePreviewFile {
  fileName: string;
  /** The status a commit of these bytes would record. */
  status: ImportStatus;
  /** Employee-day rows the file holds. 0 for a rest-day report. */
  rowCount: number;
  /** Fiscal months this file would re-fold, as display labels ("26/04"). */
  monthLabels: readonly string[];
  /** 出勤日期 present in the file, ISO, ascending. */
  workDates: readonly string[];
  /** Note or failure summary, exactly as it would be stored. */
  message: string | null;
  /** True for a rest-day report - the UI labels it 休日报表 rather than showing a bare 0. */
  isRestDay: boolean;
  /**
   * True when import_log already holds a SUCCESS/PARTIAL for this file name (D-123).
   * The commit refuses these unless the operator explicitly allows re-import.
   */
  alreadyImported: boolean;
}

export interface AttendancePreview {
  files: readonly AttendancePreviewFile[];
  /** Files the guard rejected before parsing, with the reason. Not parseable, not writable. */
  rejected: readonly { fileName: string; message: string }[];
  /** True when any accepted file was already imported successfully before. */
  needsReimportConfirmation: boolean;
}

export type AttendancePreviewResult =
  | { ok: true; preview: AttendancePreview }
  | { ok: false; message: string };

/** One file's line in the commit result. */
export interface AttendanceCommitFile {
  fileName: string;
  status: ImportStatus;
  /** Rows actually written to attendance_raw - from the repository, not from the parse. */
  rowsStored: number;
  monthLabels: readonly string[];
  message: string | null;
  isRestDay: boolean;
  /** False when even the import_log write failed, i.e. this attempt is not in the audit trail. */
  logged: boolean;
}

export interface AttendanceCommitSummary {
  files: readonly AttendanceCommitFile[];
  rejected: readonly { fileName: string; message: string }[];
  /** Files with status SUCCESS. */
  succeeded: number;
  /** Rows written across the whole batch. */
  rowsStored: number;
}

export type AttendanceCommitResult =
  | { ok: true; summary: AttendanceCommitSummary }
  | { ok: false; message: string };

/** One rejected file, as both result shapes carry it. */
interface RejectedFile {
  fileName: string;
  message: string;
}

/** Bytes plus the identity the log needs, for a file that passed every guard. */
interface AcceptedFile {
  fileName: string;
  buffer: Buffer;
  fileMtime: Date | null;
}

function monthLabelsOf(
  months: readonly { fiscalYear: number; month: number }[],
): readonly string[] {
  return months.map((month) => fiscalMonthLabel(month.fiscalYear, month.month));
}

/**
 * Applies every guard to the submitted form and splits the files into accepted and
 * rejected, reading bytes only for the ones that got that far.
 *
 * Returns a batch-level failure only for conditions that cannot be blamed on one file
 * (nothing selected, too many files, batch too large). Everything else lands in
 * `rejected`, so one renamed file never costs the operator the other two uploads.
 */
async function readUploads(
  formData: FormData,
  now: Date,
): Promise<
  { ok: true; accepted: AcceptedFile[]; rejected: RejectedFile[] } | { ok: false; message: string }
> {
  const entries = formData.getAll("files").filter((entry): entry is File => {
    return entry instanceof File;
  });

  const batch = checkUploadBatch(
    entries.map((file) => ({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    })),
  );
  if (!batch.ok) {
    return { ok: false, message: batch.message };
  }

  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of entries) {
    const named = file.name.trim() === "" ? "(未命名文件)" : file.name.trim();
    const candidate = checkUploadCandidate({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    });
    if (!candidate.ok) {
      rejected.push({ fileName: named, message: candidate.message });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (error) {
      console.error(`[attendanceImport] failed to read the upload stream for ${named}`, error);
      rejected.push({ fileName: named, message: `${named}：读取上传内容失败，请重试。` });
      continue;
    }

    const signature = checkWorkbookSignature(named, buffer);
    if (!signature.ok) {
      rejected.push({ fileName: named, message: signature.message });
      continue;
    }

    accepted.push({
      fileName: named,
      buffer,
      fileMtime: sanitiseFileMtime(file.lastModified, now),
    });
  }

  if (accepted.length === 0 && rejected.length === 0) {
    return { ok: false, message: "请先选择至少一个考勤文件。" };
  }
  return { ok: true, accepted, rejected };
}

/**
 * Parses the uploaded files and reports what would be recorded. Writes nothing.
 *
 * The D-123 duplicate lookup runs here too, so the operator learns a file was already
 * imported BEFORE approving it - not after the commit refuses.
 */
export async function previewAttendanceImport(
  formData: FormData,
): Promise<AttendancePreviewResult> {
  const uploads = await readUploads(formData, new Date());
  if (!uploads.ok) {
    return { ok: false, message: uploads.message };
  }

  const files: AttendancePreviewFile[] = [];
  let needsReimportConfirmation = false;

  for (const upload of uploads.accepted) {
    let inspected: InspectResult;
    try {
      inspected = inspectAttendanceSource({
        buffer: upload.buffer,
        fileName: upload.fileName,
      });
    } catch (error) {
      // The parser throwing is not a parse problem - those come back as ok:false. This is
      // a defect or a malformed OLE2 container, and it must not take down the whole
      // preview when the other files are fine.
      console.error(`[previewAttendanceImport] parser threw on ${upload.fileName}`, error);
      files.push({
        fileName: upload.fileName,
        status: "FAILED",
        rowCount: 0,
        monthLabels: [],
        workDates: [],
        message: "解析文件时发生意外错误，该文件无法导入。请确认这是 HR 导出的日考勤报表。",
        isRestDay: false,
        alreadyImported: false,
      });
      continue;
    }

    let alreadyImported = false;
    try {
      alreadyImported = await hasSuccessfulImport(upload.fileName);
    } catch (error) {
      // A duplicate check that cannot run must not block the preview: the commit enforces
      // the same gate against the database again, so the worst case here is that the
      // operator is not warned early.
      console.error(
        `[previewAttendanceImport] duplicate lookup failed for ${upload.fileName}`,
        error,
      );
    }
    if (alreadyImported) {
      needsReimportConfirmation = true;
    }

    files.push({
      fileName: upload.fileName,
      status: inspected.verdict.status,
      rowCount: inspected.verdict.rowCount,
      monthLabels: monthLabelsOf(inspected.months),
      workDates: inspected.workDates,
      message: inspected.verdict.errorMessage,
      isRestDay: inspected.verdict.isRestDay,
      alreadyImported,
    });
  }

  return {
    ok: true,
    preview: { files, rejected: uploads.rejected, needsReimportConfirmation },
  };
}

/**
 * Writes the uploaded files into attendance_raw and re-folds the affected months.
 *
 * Per file, not atomic across the batch - see the module note. Each file's own write IS
 * atomic (importAttendanceRows runs in a transaction), so a failure leaves that file's
 * months exactly as they were.
 *
 * The re-import gate is enforced HERE, not only in the UI. A checkbox in the browser
 * cannot protect stored data: this endpoint is reachable without it, and re-importing a
 * file whose month has since been hand-corrected silently discards that correction.
 */
export async function commitAttendanceImport(
  formData: FormData,
): Promise<AttendanceCommitResult> {
  const allowReimport = formData.get("allowReimport") === "yes";
  const uploads = await readUploads(formData, new Date());
  if (!uploads.ok) {
    return { ok: false, message: uploads.message };
  }

  const files: AttendanceCommitFile[] = [];
  const rejected: RejectedFile[] = [...uploads.rejected];

  for (const upload of uploads.accepted) {
    if (!allowReimport) {
      let alreadyImported = false;
      try {
        alreadyImported = await hasSuccessfulImport(upload.fileName);
      } catch (error) {
        // Fail CLOSED. If the audit table cannot be read, there is no way to tell a first
        // import from a re-import, and the destructive reading is the one to assume: a
        // re-fold replaces a month that may have been corrected by hand.
        console.error(
          `[commitAttendanceImport] duplicate lookup failed for ${upload.fileName}`,
          error,
        );
        rejected.push({
          fileName: upload.fileName,
          message: `${upload.fileName}：无法确认该文件是否已导入过（数据库读取失败），已跳过以避免覆盖既有数据。`,
        });
        continue;
      }
      if (alreadyImported) {
        rejected.push({
          fileName: upload.fileName,
          message:
            `${upload.fileName}：该文件名已成功导入过。重新导入会覆盖对应月份的实绩数据，` +
            `请勾选「允许重新导入」后重试。`,
        });
        continue;
      }
    }

    const result = await ingestAttendanceSource({
      buffer: upload.buffer,
      fileName: upload.fileName,
      fileMtime: upload.fileMtime,
      triggeredBy: UPLOAD_TRIGGER,
    });

    files.push({
      fileName: result.fileName,
      status: result.status,
      rowsStored: result.rowsStored,
      monthLabels: monthLabelsOf(result.months),
      message: result.errorMessage,
      isRestDay: result.isRestDay,
      logged: result.logId !== null,
    });
  }

  const rowsStored = files.reduce((sum, file) => sum + file.rowsStored, 0);

  // Outside every write and guarded by its own try: the rows are committed by this point,
  // so a revalidate failure must not be reported as a failed import - that would send the
  // operator to re-upload data that is already stored.
  if (rowsStored > 0) {
    try {
      revalidatePath("/actuals");
      revalidatePath("/actuals/import");
      revalidatePath("/");
    } catch (error) {
      console.error(
        "[commitAttendanceImport] revalidatePath failed after a committed write",
        error,
      );
    }
  }

  return {
    ok: true,
    summary: {
      files,
      rejected,
      succeeded: files.filter((file) => file.status === "SUCCESS").length,
      rowsStored,
    },
  };
}
