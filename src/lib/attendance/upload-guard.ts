// Everything an uploaded attendance workbook must satisfy before the parser sees it.
//
// A Server Action is a public HTTP endpoint, and the thing behind this one is an XLS
// parser - exactly the kind of code that should not be handed arbitrary bytes. The checks
// here run on the size and the first eight bytes, all of which are known before any
// workbook structure is interpreted.
//
// Deliberately pure: no prisma, no node:fs, no File. The callers pass a plain
// {name, size, lastModified} shape, so every branch below is unit-testable without
// constructing a browser object or reading a 450KB fixture off disk.
//
// NOT a copy of the plan importer's readUpload(), and the difference matters. That one
// hard-codes the ZIP magic because a plan workbook is always .xlsx. HR's attendance
// export is .xls - an OLE2 compound file, whose first bytes are d0cf11e0a1b11ae1 and
// share nothing with a ZIP header. Reusing the plan check here would reject 100% of real
// attendance files with a message telling the operator their file is corrupt.

/**
 * Per-file ceiling. 日考勤数据模版.xls measures 450,560 bytes, so this is ~9x headroom -
 * enough for HR adding headcount or columns, still far below anything that could only be
 * an attempt to exhaust memory inside the parser.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Whole-batch ceiling, checked separately because ten in-bounds files are not
 * automatically an in-bounds request: the bytes are held in memory together.
 */
export const MAX_BATCH_BYTES = 12 * 1024 * 1024;

/**
 * File count ceiling. A Monday backlog is 2-3 files (Sat, Sun, Mon); ten covers a week
 * of missed uploads plus corrections and still bounds the number of write transactions
 * one request can open.
 */
export const MAX_FILE_COUNT = 10;

/** Excel writes a `~$name.xls` lock file beside an open workbook. Never a workbook. */
const LOCK_FILE_PREFIX = "~$";

/**
 * Accepted extension paired with the container signature that extension implies.
 *
 * `.xls` is OLE2/CFB (the Compound File Binary header); `.xlsx` is a ZIP local file
 * header. The pairing is the point: it catches a `.xls` renamed to `.xlsx` in either
 * direction, which otherwise reaches the parser and fails as "unreadable workbook" -
 * a message that sends the operator looking for corruption instead of a wrong extension.
 *
 * `.csv` (D-221) has `magic: null` because a text file has no signature, so that half of
 * the defence is unavailable for it. It is not simply dropped: the check inverts for CSV
 * and refuses bytes that DO carry a workbook signature, catching an .xls renamed to .csv.
 * What a signature would have proved - "the content really is an attendance report" - is
 * proved further in by the header assertions in csv.ts and mapHeader(), which are
 * stronger than any magic number because they check the columns rather than the container.
 */
const ACCEPTED_FORMATS = [
  {
    extension: ".xls",
    label: "Excel 97-2003 (.xls)",
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
  {
    extension: ".xlsx",
    label: "Excel 2007+ (.xlsx)",
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
  {
    extension: ".csv",
    label: "CSV 文本 (.csv)",
    magic: null,
  },
] as const;

/** Extensions the operator is told about, in the order they appear above. */
const ACCEPTED_EXTENSIONS = ".xls / .xlsx / .csv";


/**
 * Earliest mtime treated as real. The system covers FY2026 onward, so any timestamp
 * before 2020 is a clock fault or a filesystem that lost the attribute - storing it
 * would put a 1970 date in the provenance column and make the /actuals 文件时间 column
 * read as though HR published the file decades ago.
 */
const MTIME_FLOOR = Date.UTC(2020, 0, 1);

/** Tolerance for a browser clock running ahead of the server's. */
const MTIME_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** The minimum a caller must know about an upload to have it judged. */
export interface UploadCandidate {
  name: string;
  size: number;
  /** Epoch milliseconds, as `File.lastModified` reports it. */
  lastModified: number;
}

/** Verdict on one check. The message is operator-facing and names the file. */
export type GuardResult = { ok: true } | { ok: false; message: string };

const OK: GuardResult = { ok: true };

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Extension match, case-insensitive. Null when the name carries none of them. */
function formatOf(name: string): (typeof ACCEPTED_FORMATS)[number] | null {
  const lower = name.toLowerCase();
  return ACCEPTED_FORMATS.find((format) => lower.endsWith(format.extension)) ?? null;
}

/**
 * Checks one file's name and size.
 *
 * Runs before the bytes are read, so a 500MB upload is refused without being pulled into
 * memory. The magic number cannot be checked here for that same reason - it needs the
 * buffer, and that is a separate call the action makes after this one passes.
 */
export function checkUploadCandidate(file: UploadCandidate): GuardResult {
  const name = file.name.trim();
  if (name === "") {
    return { ok: false, message: "上传的文件没有文件名，无法记录来源，已跳过。" };
  }
  if (name.startsWith(LOCK_FILE_PREFIX)) {
    return {
      ok: false,
      message:
        `${name}：这是 Excel 的临时锁文件（文件名以 ~$ 开头），不是考勤数据。` +
        `请关闭正在编辑的 Excel 后重新选择真正的考勤文件。`,
    };
  }
  if (formatOf(name) === null) {
    return {
      ok: false,
      message: `${name}：只接受 ${ACCEPTED_EXTENSIONS} 文件。HR 导出的日考勤报表是 .csv 格式。`,
    };
  }
  if (file.size === 0) {
    return {
      ok: false,
      message: `${name}：文件为空（0 字节）。可能是复制过程中断，请重新从来源取一份。`,
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      message:
        `${name}：${formatMegabytes(file.size)}MB 超过单文件 ` +
        `${formatMegabytes(MAX_FILE_BYTES)}MB 上限。日考勤报表通常不到 1MB，请确认选对了文件。`,
    };
  }
  return OK;
}

/**
 * Checks the batch as a whole: how many files, and how many bytes together.
 *
 * Separate from the per-file check because it is the only failure that cannot be
 * attributed to one file - rejecting the batch is the honest outcome, and the message
 * says so rather than blaming whichever file happened to be last.
 */
export function checkUploadBatch(files: readonly UploadCandidate[]): GuardResult {
  if (files.length === 0) {
    return { ok: false, message: "请先选择至少一个考勤文件。" };
  }
  if (files.length > MAX_FILE_COUNT) {
    return {
      ok: false,
      message:
        `一次最多上传 ${String(MAX_FILE_COUNT)} 个文件，本次选择了 ` +
        `${String(files.length)} 个。请分批上传。`,
    };
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BATCH_BYTES) {
    return {
      ok: false,
      message:
        `本次选择的 ${String(files.length)} 个文件合计 ${formatMegabytes(totalBytes)}MB，` +
        `超过单次 ${formatMegabytes(MAX_BATCH_BYTES)}MB 上限。请减少文件数后重试。`,
    };
  }
  return OK;
}

/**
 * Confirms the bytes match the container the extension promised.
 *
 * For `.xls` / `.xlsx` this is the one check the operator cannot get wrong by accident and
 * cannot talk their way past: the extension states intent, the signature states fact. A
 * mismatch is reported as a rename rather than as corruption, because that is what it
 * almost always is - somebody saved a CSV as .xls, or renamed an .xlsx to match a
 * colleague's file.
 *
 * For `.csv` the test inverts. Text has no signature to match, so what is checked instead
 * is that the bytes do NOT carry a workbook signature - an .xls renamed to .csv would
 * otherwise reach the CSV decoder and be reported as an encoding problem, which is a true
 * statement about a binary file and a useless one to act on.
 */
export function checkWorkbookSignature(name: string, bytes: Uint8Array): GuardResult {
  const format = formatOf(name.trim());
  if (format === null) {
    return {
      ok: false,
      message: `${name}：只接受 ${ACCEPTED_EXTENSIONS} 文件。`,
    };
  }

  /** The workbook format whose signature these bytes actually carry, if any. */
  const signed = ACCEPTED_FORMATS.find((candidate) => {
    return (
      candidate.magic !== null &&
      candidate.magic.length <= bytes.length &&
      candidate.magic.every((byte, index) => bytes[index] === byte)
    );
  });

  if (format.magic === null) {
    if (signed !== undefined) {
      return {
        ok: false,
        message:
          `${name}：文件内容实际是 ${signed.label} 格式，扩展名却是 .csv。` +
          `请把扩展名改回 ${signed.extension}，或在 Excel 中另存为 CSV 后重新上传。`,
      };
    }
    // Nothing more can be asserted from the bytes alone. Whether this text really is an
    // attendance report is decided by the header check in csv.ts and by mapHeader().
    return OK;
  }

  if (bytes.length < format.magic.length) {
    return {
      ok: false,
      message: `${name}：文件内容过短（${String(bytes.length)} 字节），不是有效的 Excel 文件。`,
    };
  }
  if (signed?.extension === format.extension) {
    return OK;
  }

  const hint =
    signed === undefined
      ? `文件内容既不是 .xls 也不是 .xlsx 格式，请确认这是 Excel 导出的考勤报表。` +
        `如果这是 HR 导出的 CSV 文本，请把扩展名改为 .csv 后重新上传。`
      : `文件内容实际是 ${signed.label} 格式，扩展名被改成了 ${format.extension}。` +
        `请把扩展名改回 ${signed.extension}，或在 Excel 中打开后另存为 ${format.extension}。`;
  return { ok: false, message: `${name}：${hint}` };
}

/**
 * Turns a browser-reported `lastModified` into the mtime stored on the ImportLog row,
 * or null when the value cannot be trusted.
 *
 * `File.lastModified` is client-supplied and falls back to Date.now() when the platform
 * has no timestamp, so it is an unvalidated input like any other form field. Null is a
 * first-class outcome here - ImportLog.fileMtime is nullable precisely so an unknown
 * timestamp stays visibly unknown instead of becoming a plausible-looking wrong date in
 * the provenance trail.
 */
export function sanitiseFileMtime(lastModified: number, now: Date): Date | null {
  if (!Number.isFinite(lastModified) || lastModified <= 0) {
    return null;
  }
  if (lastModified < MTIME_FLOOR) {
    return null;
  }
  if (lastModified > now.getTime() + MTIME_FUTURE_TOLERANCE_MS) {
    return null;
  }
  return new Date(lastModified);
}
