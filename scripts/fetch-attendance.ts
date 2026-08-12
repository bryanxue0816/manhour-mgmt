// Attendance fetch entry point (D-120 / D-121 / D-123).
//
// Run:
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/fetch-attendance.ts --file "../日考勤数据模版.xls"
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/fetch-attendance.ts --dir "\\\\server\\share\\attendance"
//   ... --dir <目录A> --trigger schedule      # what an OS scheduler invokes
//
// Exactly one of --file / --dir is required, and there is no default for either. ⏳D-207
// (目录 A 的具体访问路径与账号权限) is still open with IT/HR, and a hard-coded guess at a
// UNC path would fail as "目录不可访问" against a share that may not even be the right
// one - an error that reads like an outage rather than like a missing decision. When
// D-207 lands, the answer belongs in the scheduler's command line or in an env var, not
// inlined here.
//
// Scheduling itself is external, per D-121: the main run and the hourly retries until
// 18:00 are the OS scheduler's job, and their clock time depends on ⏳D-208 (when HR
// finishes the export). This script is one attempt, and it says what happened.
//
// Exit codes, so a scheduler can act without parsing output:
//   0  every attempted file reached SUCCESS (or there was nothing new to import)
//   1  at least one file was PARTIAL, or the directory was unreachable
//   2  at least one file FAILED, or an ImportLog row could not be written
// PARTIAL is separated from FAILED because rows DID land - the月度 aggregates are live and
// the operator is reviewing a warning, not restoring from nothing.

import { IMPORT_TRIGGERS } from "../src/lib/db/import-log.repo";
import {
  ingestAttendanceFile,
  scanAttendanceDirectory,
  type IngestResult,
} from "../src/lib/attendance/ingest";
import type { ImportTrigger } from "../src/lib/db/types";
import { prisma } from "../src/lib/prisma";

const EXIT_OK = 0;
const EXIT_PARTIAL = 1;
const EXIT_FAILED = 2;

const USAGE = [
  "用法：",
  "  fetch-attendance.ts --file <考勤文件路径> [--trigger manual|schedule|retry]",
  "  fetch-attendance.ts --dir  <目录A 路径>   [--trigger manual|schedule|retry]",
  "",
  "  --file  导入单个文件（无论 ImportLog 是否已有记录，均重新导入；D-122 幂等覆盖）",
  "  --dir   扫描目录，跳过 ImportLog 中已 SUCCESS/PARTIAL 的文件（D-123 幂等）",
  "  --trigger  默认 manual；由计划任务调用时应显式传 schedule 或 retry",
].join("\n");

interface CliOptions {
  file: string | null;
  dir: string | null;
  triggeredBy: ImportTrigger;
}

/**
 * Parses `--key value` pairs.
 *
 * Unknown flags are a hard error rather than ignored: a mistyped `--dirr` would otherwise
 * silently fall through to "no source given", and on a scheduled run that reads as a
 * configuration outage instead of a typo.
 */
function parseArgs(argv: readonly string[]): CliOptions {
  let file: string | null = null;
  let dir: string | null = null;
  let trigger = "manual";

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) continue;
    const value = argv[i + 1];
    if (flag !== "--file" && flag !== "--dir" && flag !== "--trigger") {
      throw new Error(`未知参数：${flag}\n\n${USAGE}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少值\n\n${USAGE}`);
    }
    if (flag === "--file") file = value;
    else if (flag === "--dir") dir = value;
    else trigger = value;
    i += 1;
  }

  if ((file === null) === (dir === null)) {
    throw new Error(`必须且只能指定 --file 或 --dir 之一\n\n${USAGE}`);
  }
  const triggeredBy = IMPORT_TRIGGERS.find((t) => t === trigger);
  if (triggeredBy === undefined) {
    throw new Error(
      `--trigger 非法值：${trigger}。允许值：${IMPORT_TRIGGERS.join(" / ")}`,
    );
  }
  return { file, dir, triggeredBy };
}

/** Prints one attempt's outcome, including the per-month rebuild figures. */
function reportResult(result: IngestResult): void {
  const mtime = result.fileMtime === null ? "（未知）" : result.fileMtime.toISOString();
  console.log(`\n[${result.status}] ${result.fileName}`);
  console.log(`  文件时间   : ${mtime}`);
  console.log(`  入库行数   : ${String(result.rowsStored)}`);
  console.log(`  ImportLog  : ${result.logId ?? "写入失败（本次尝试未留痕）"}`);
  if (result.errorMessage !== null) {
    console.log(`  说明       : ${result.errorMessage}`);
  }
  for (const month of result.months) {
    const label = `FY${String(month.fiscalYear)} 第 ${String(month.month)} 月`;
    console.log(
      `  ${label}：源行 ${String(month.sourceRows)} / 聚合 ${String(month.actualRows)} 课 / ` +
        `未归属 ${String(month.unattributedRows)} 行 ${String(month.unattributedHours)} h`,
    );
    for (const group of month.unattributed) {
      const section = group.hrSectionName ?? "（无课别）";
      console.log(
        `      未归属：${group.hrDeptName} / ${section} ` +
          `— ${String(group.rowCount)} 行 ${String(group.totalHours)} h`,
      );
    }
  }
}

/** Worst outcome across a set of attempts, as an exit code. */
function exitCodeOf(results: readonly IngestResult[]): number {
  if (results.some((r) => r.status === "FAILED" || r.logId === null)) return EXIT_FAILED;
  if (results.some((r) => r.status === "PARTIAL")) return EXIT_PARTIAL;
  return EXIT_OK;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.file !== null) {
    const result = await ingestAttendanceFile(options.file, options.triggeredBy);
    reportResult(result);
    return exitCodeOf([result]);
  }

  const dir = options.dir;
  if (dir === null) {
    // Unreachable - parseArgs enforces exactly one source. Kept because falling through
    // with no source would report success on an import that never ran.
    throw new Error("fetch-attendance: 未指定数据源");
  }

  const scan = await scanAttendanceDirectory(dir, options.triggeredBy);
  console.log(`扫描目录：${scan.directory}`);
  if (scan.errorMessage !== null) {
    console.error(`  ${scan.errorMessage}`);
    return EXIT_PARTIAL;
  }
  console.log(`  发现工作簿 ${String(scan.candidates.length)} 个`);
  if (scan.skipped.length > 0) {
    console.log(`  已导入跳过 ${String(scan.skipped.length)} 个：${scan.skipped.join(", ")}`);
  }
  if (scan.results.length === 0) {
    console.log("  无新文件需要导入。");
    return EXIT_OK;
  }
  for (const result of scan.results) {
    reportResult(result);
  }
  return exitCodeOf(scan.results);
}

// tsx cannot take top-level await in this project, hence the void-wrapped call. The
// disconnect runs in every branch: better-sqlite3 holds the dev.db file lock, and a
// scheduled run that leaks it would block the next migration.
void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_FAILED;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
