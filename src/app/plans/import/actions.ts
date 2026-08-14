// Server Actions for the Excel plan-workbook import (D-142 bulk import).
//
// TWO STEPS, ONE PARSER. `previewPlanImport` shows the administrator what would be
// written; `commitPlanImport` writes it. Both run the SAME parse-and-match pipeline
// from scratch on the uploaded bytes.
//
// Re-parsing in step 2 is deliberate, and the alternative is what makes it necessary:
// caching the parsed rows between the two calls would mean the bytes that were
// APPROVED and the rows that get WRITTEN are linked only by a server-side handle. Any
// bug or tampering in that handle writes numbers nobody previewed, and the audit trail
// would faithfully record the wrong figures as approved. Re-parsing costs ~50ms on a
// 15KB sheet and removes the possibility.
//
// Consequence for the client: it must send the file twice. That is why there is no
// hidden upload id in the payload - the file itself is the only thing carried forward.
//
// A Server Action is a public HTTP endpoint. The uploaded object is checked for size,
// extension AND magic number before it reaches the XLSX parser, because a parser is
// exactly the kind of code that should not be handed arbitrary bytes.

"use server";

import { revalidatePath } from "next/cache";

import { findFiscalYearById } from "@/lib/db/fiscal-year.repo";
import { loadOrgSnapshot } from "@/lib/db/org.repo";
import { countPlansByFiscalYear, upsertPlansBulkWithAudit } from "@/lib/db/plan.repo";
import {
  matchPlanSections,
  parsePlanWorkbook,
  type ImportProblem,
} from "@/lib/plans/import";
import {
  collectChallengeWarnings,
  summariseChallengeWarnings,
} from "@/lib/plans/validate";

/**
 * Identity recorded on every imported row and audit entry.
 *
 * Distinct from the grid's "admin" so the trail can tell a bulk import from a manual
 * edit without joining anything: a cell whose last author is `import` was set by a
 * spreadsheet, and the one next to it saying `admin` was typed by hand. v1 has no
 * account system (D-008 intranet allow-listing, D-142 1-2 administrators), so this is
 * the provenance the audit trail can actually attest to.
 */
const IMPORT_ACTOR = "import";

/**
 * Upload ceiling. The authoritative FY26工时计划.xlsx is 15,654 bytes, so 2MB is
 * ~130x headroom for added sheets, styles and history while still refusing anything
 * that could only be an attempt to exhaust memory in the parser.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** ZIP local-file-header signature - `.xlsx` is a ZIP container. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/** Guards the required free-text reason against an unbounded write. */
const REASON_MAX_LENGTH = 200;

/** One section's numbers as the preview table renders them. */
export interface PlanImportPreviewSection {
  dept: string;
  section: string;
  /** 12 values, index 0 = April. */
  planned: readonly number[];
  challenge: readonly number[];
  /** Sum over the fiscal year, precomputed so the table does not fold in render. */
  plannedTotal: number;
  challengeTotal: number;
}

export interface PlanImportPreview {
  fiscalYearId: string;
  fiscalYearName: string;
  sections: readonly PlanImportPreviewSection[];
  /** Rows that would be written: sections x 12. */
  rowCount: number;
  /**
   * Rows already stored for this fiscal year. Non-zero means this import OVERWRITES,
   * and the UI must not let it proceed without an explicit confirmation.
   */
  existingRowCount: number;
  /** D-151 permits challenge < planned; surfaced as a notice, never a blocker. */
  challengeWarning: string | null;
}

export type PlanImportPreviewResult =
  | { ok: true; preview: PlanImportPreview }
  | { ok: false; message: string; problems: readonly ImportProblem[] };

export interface PlanImportCommitSummary {
  fiscalYearName: string;
  rowsWritten: number;
  created: number;
  updated: number;
  /** Audit entries appended (D-143). 0 means the file matched what was stored. */
  loggedChanges: number;
  challengeWarning: string | null;
}

export type PlanImportCommitResult =
  | { ok: true; summary: PlanImportCommitSummary }
  | { ok: false; message: string; problems: readonly ImportProblem[] };

/** Failure shape helper - keeps the early returns to one line each. */
function fail(
  message: string,
  problems: readonly ImportProblem[] = [],
): { ok: false; message: string; problems: readonly ImportProblem[] } {
  return { ok: false, message, problems };
}

/**
 * Turns the uploaded object into bytes, rejecting anything that is not plausibly an
 * `.xlsx` file BEFORE the parser sees it.
 *
 * Three independent checks, because each catches what the others cannot:
 *   * size, so a 500MB upload is refused before it is read into memory;
 *   * extension, which is the only signal that matches the administrator's intent;
 *   * magic number, which is the only signal the administrator cannot get wrong -
 *     a `.xls` or `.csv` renamed to `.xlsx` fails here with a message that says so,
 *     rather than surfacing as an unreadable-workbook error.
 */
async function readUpload(
  file: unknown,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; message: string }> {
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "请选择一个 Excel 文件。" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      message: `文件 ${mb}MB 超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB 上限。工时计划表通常不到 100KB,请确认选择的文件正确。`,
    };
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return {
      ok: false,
      message: "只接受 .xlsx 文件。若源文件是 .xls 或 .csv,请先用 Excel 另存为 .xlsx。",
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (error) {
    console.error("[planImport] failed to read the upload stream", error);
    return { ok: false, message: "读取上传文件失败,请重试。" };
  }

  if (buffer.length < ZIP_MAGIC.length) {
    return { ok: false, message: "文件内容为空或已损坏。" };
  }
  const magicMatches = ZIP_MAGIC.every((byte, index) => buffer[index] === byte);
  if (!magicMatches) {
    return {
      ok: false,
      message:
        "文件内容不是 .xlsx 格式(扩展名可能被改过)。请在 Excel 中打开后另存为 .xlsx。",
    };
  }
  return { ok: true, buffer };
}

/**
 * Reads and bounds the import reason, which D-174 makes REQUIRED.
 *
 * Only the commit step calls this. The preview writes nothing and produces no audit
 * entry, so demanding a justification before the operator has even seen what the file
 * contains would ask them to explain a change they cannot yet inspect.
 *
 * Enforced here rather than only by the form: a Server Action is a public HTTP endpoint,
 * so an omitted field must be refused by the server, not merely discouraged in the UI.
 */
function readReason(
  raw: unknown,
): { ok: true; reason: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "请填写导入说明后再导入。" };
  }
  const reason = raw.trim();
  if (reason.length > REASON_MAX_LENGTH) {
    return { ok: false, message: `导入说明最长 ${REASON_MAX_LENGTH} 字。` };
  }
  return { ok: true, reason };
}

/**
 * Parses and validates an uploaded workbook without writing anything.
 *
 * Reports EVERY problem it finds rather than the first, so an administrator fixing a
 * 576-cell sheet gets one list instead of one round-trip per bad cell.
 */
export async function previewPlanImport(
  formData: FormData,
): Promise<PlanImportPreviewResult> {
  const fiscalYearId = formData.get("fiscalYearId");
  if (typeof fiscalYearId !== "string" || fiscalYearId.trim() === "") {
    return fail("请先选择要导入的财年。");
  }

  const upload = await readUpload(formData.get("file"));
  if (!upload.ok) {
    return fail(upload.message);
  }

  const fiscalYear = await findFiscalYearById(fiscalYearId);
  if (fiscalYear === null) {
    return fail("所选财年不存在,请刷新页面后重试。");
  }

  const parsed = parsePlanWorkbook(upload.buffer);
  if (!parsed.ok) {
    return fail("文件格式不符合要求,未做任何写入。请按下列问题修正后重新上传。", parsed.problems);
  }

  const snapshot = await loadOrgSnapshot();
  const matched = matchPlanSections(parsed.sections, snapshot, fiscalYearId);
  if (!matched.ok) {
    return fail(
      "文件中的部门/课与系统主数据不一致,未做任何写入。请核对下列问题。",
      matched.problems,
    );
  }

  const existingRowCount = await countPlansByFiscalYear(fiscalYearId);
  const challengeWarning = summariseChallengeWarnings(
    collectChallengeWarnings(matched.matched.rows),
  );

  const sections = parsed.sections.map<PlanImportPreviewSection>((section) => ({
    dept: section.dept,
    section: section.section,
    planned: section.planned,
    challenge: section.challenge,
    plannedTotal: section.planned.reduce((sum, value) => sum + value, 0),
    challengeTotal: section.challenge.reduce((sum, value) => sum + value, 0),
  }));

  return {
    ok: true,
    preview: {
      fiscalYearId,
      fiscalYearName: fiscalYear.name,
      sections,
      rowCount: matched.matched.rows.length,
      existingRowCount,
      challengeWarning,
    },
  };
}

/**
 * Writes an uploaded workbook into the plan table, all rows or none (D-142, D-143).
 *
 * Re-runs the entire parse and match on the submitted bytes - see the module note on
 * why the preview's result is not carried over.
 *
 * The overwrite confirmation is enforced HERE, not only in the UI. A checkbox in the
 * browser cannot protect 288 stored rows: this endpoint is reachable without it, and
 * overwriting a fiscal year an administrator has already hand-corrected is the most
 * expensive mistake this feature can make.
 */
export async function commitPlanImport(
  formData: FormData,
): Promise<PlanImportCommitResult> {
  const fiscalYearId = formData.get("fiscalYearId");
  if (typeof fiscalYearId !== "string" || fiscalYearId.trim() === "") {
    return fail("请先选择要导入的财年。");
  }

  const reasonResult = readReason(formData.get("reason"));
  if (!reasonResult.ok) {
    return fail(reasonResult.message);
  }

  const upload = await readUpload(formData.get("file"));
  if (!upload.ok) {
    return fail(upload.message);
  }

  const fiscalYear = await findFiscalYearById(fiscalYearId);
  if (fiscalYear === null) {
    return fail("所选财年不存在,请刷新页面后重试。");
  }

  const parsed = parsePlanWorkbook(upload.buffer);
  if (!parsed.ok) {
    return fail("文件格式不符合要求,未做任何写入。", parsed.problems);
  }

  const snapshot = await loadOrgSnapshot();
  const matched = matchPlanSections(parsed.sections, snapshot, fiscalYearId);
  if (!matched.ok) {
    return fail("文件中的部门/课与系统主数据不一致,未做任何写入。", matched.problems);
  }

  const existingRowCount = await countPlansByFiscalYear(fiscalYearId);
  const confirmedOverwrite = formData.get("confirmOverwrite") === "yes";
  if (existingRowCount > 0 && !confirmedOverwrite) {
    return fail(
      `财年 ${fiscalYear.name} 已有 ${existingRowCount} 条计划数据。` +
        `继续导入会覆盖这些数据(每个变化的数值都会记入修改履历),请勾选覆盖确认后重试。`,
    );
  }

  let written: Awaited<ReturnType<typeof upsertPlansBulkWithAudit>>;
  try {
    written = await upsertPlansBulkWithAudit(
      matched.matched.rows,
      IMPORT_ACTOR,
      // No synthesised fallback: a generated string like "Excel 批量导入" would fill the
      // column while telling a later reader nothing D-174 asked for.
      reasonResult.reason,
    );
  } catch (error) {
    console.error(
      `[commitPlanImport] bulk write failed for fiscalYear=${fiscalYearId} ` +
        `rows=${String(matched.matched.rows.length)}`,
      error,
    );
    return fail(
      "写入失败,本次导入已整体回滚,数据保持导入前的状态。请重试;若持续失败请联系管理员。",
    );
  }

  // Outside the write's try and guarded by its own: the rows are committed by this
  // point, so a revalidate failure must not be reported as a failed import - that
  // would send the administrator to re-upload data that is already stored.
  try {
    revalidatePath("/plans");
    revalidatePath("/plans/import");
    revalidatePath("/");
  } catch (error) {
    console.error("[commitPlanImport] revalidatePath failed after a committed write", error);
  }

  return {
    ok: true,
    summary: {
      fiscalYearName: fiscalYear.name,
      rowsWritten: written.rowsWritten,
      created: written.created,
      updated: written.updated,
      loggedChanges: written.loggedChanges,
      challengeWarning: summariseChallengeWarnings(
        collectChallengeWarnings(matched.matched.rows),
      ),
    },
  };
}
