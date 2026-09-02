// Chinese labels for the two import-log vocabularies, shared by every surface that
// renders an import attempt.
//
// Extracted from /actuals when /admin/audit grew its own import tab (D-226). Two private
// copies of these maps would let the same attempt read 「失败」 on one page and something
// else on the other, and this table exists precisely so an operator can settle "did
// today's import land" without cross-checking two screens.
//
// Prisma-free, like ./import-status, so a test can assert the maps stay exhaustive
// without lib/prisma.ts constructing a database client at module load.

import type { ImportStatus, ImportTrigger } from "./types";

/**
 * Full Record, not Partial: if a vocabulary in ./import-status ever grows a member,
 * this file fails to compile instead of rendering the string "undefined" into a status
 * cell that somebody is reading to decide whether the data is trustworthy.
 */
export const IMPORT_STATUS_LABELS: Readonly<Record<ImportStatus, string>> = {
  SUCCESS: "成功",
  PARTIAL: "部分成功",
  FAILED: "失败",
};

/**
 * `schedule` is deliberately 「定时」 rather than 「自动」: the row only proves a scheduled
 * run wrote it, not that nobody was standing at the terminal. D-123 keeps the three
 * triggers apart so this distinction survives into the audit trail.
 */
export const IMPORT_TRIGGER_LABELS: Readonly<Record<ImportTrigger, string>> = {
  schedule: "定时",
  manual: "手工",
  retry: "重试",
};
