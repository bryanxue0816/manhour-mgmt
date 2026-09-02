// Historical actual-hours baseline import (D-198).
//
// Run (dry run - reads and reconciles, writes nothing):
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/import-actual-baseline.ts \
//     --file ../FY2026-actual-baseline-template.csv --year 2026
// Add --apply to commit.
//
// WHY THIS EXISTS
// The system goes live partway through a fiscal year, so the months before go-live have no
// attendance detail to fold: HR's per-day export does not go back that far. Without those
// months the dashboard's cumulative actual line starts from zero mid-year and every
// year-to-date figure understates by a full quarter. The operator therefore types the
// month totals in by hand, once, from the figures the sections already reported on paper.
//
// WHY IT IS DRY-RUN BY DEFAULT
// A wrong number here is invisible. There is no second copy of these figures anywhere, no
// detail rows to re-derive them from, and a plausible-looking total renders as a perfectly
// normal bar. So the default run prints every cell it would write and changes nothing;
// --apply is a separate, deliberate act.
//
// THE ONE TRAP THIS SCRIPT EXISTS TO ABSORB
// The CSV's 月份 column is a CALENDAR label ("2026年4月") because that is what the operator
// filling it in thinks in. The database's `month` column is a FISCAL ordinal where 1 =
// April (lib/db/date.ts). Copying 4 into month=4 would file April's hours as July's - a
// three-month shift with no error, no exception, and no visible symptom. The conversion is
// therefore delegated to lib/db/date.ts#fiscalMonthFromCalendarLabel(), which routes it
// through the same fiscalMonthOf()/fiscalYearOf() the attendance pipeline uses and is unit
// tested against the April boundary, rather than re-derived here with an offset of its own.
//
// The whole batch is rejected on any unrecognised 部名/课名, any duplicate cell, and any
// month outside --year. A partial import is the worst outcome available: half a baseline
// looks exactly like a complete one on screen.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { ACTUAL_SOURCE_MANUAL } from "../src/lib/db/actual-source";
import {
  fiscalMonthFromCalendarLabel,
  fiscalMonthLabel,
} from "../src/lib/db/date";
import {
  MASTER_DATA_ALL_TARGETS,
  writeMasterDataWithAudit,
} from "../src/lib/db/master-data-change-log.repo";
import { prisma } from "../src/lib/prisma";

const EXIT_OK = 0;
const EXIT_FAILED = 1;

const EXPECTED_HEADER = ["部名", "课名", "月份", "合计工时"] as const;

const USAGE = [
  "用法：",
  "  import-actual-baseline.ts --file <CSV路径> --year <财年起始年> [--apply]",
  "",
  "  --file   CSV 文件，表头必须是：" + EXPECTED_HEADER.join(","),
  "  --year   财年起始年（2026 表示 FY2026，即 2026年4月 ~ 2027年3月）",
  "  --apply  真正写入；不加则只试算并打印，不改动数据库",
].join("\n");

interface CliOptions {
  file: string;
  year: number;
  apply: boolean;
}

/** One CSV data row, still in the sheet's own vocabulary. */
interface BaselineCell {
  /** 1-based line number in the file, for error messages the operator can act on. */
  line: number;
  departmentName: string;
  sectionName: string;
  /** The label as written, e.g. "2026年4月". Kept for reporting. */
  monthLabel: string;
  /** Fiscal month, 1 = April. Converted, never copied from the label. */
  month: number;
  totalHours: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let file: string | null = null;
  let yearText: string | null = null;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (flag !== "--file" && flag !== "--year") {
      throw new Error(`未知参数：${flag}\n\n${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少值\n\n${USAGE}`);
    }
    if (flag === "--file") file = value;
    else yearText = value;
    i += 1;
  }

  if (file === null || yearText === null) {
    throw new Error(`--file 与 --year 都是必填\n\n${USAGE}`);
  }
  const year = Number(yearText);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    throw new Error(`--year 非法值：${yearText}（应为 4 位年份，例如 2026）`);
  }
  return { file, year, apply };
}

/**
 * Turns "2026年4月" into a fiscal month.
 *
 * A one-line delegate on purpose. The conversion itself lives in lib/db/date.ts next to
 * the April=1 offset it depends on and is unit-tested there; re-deriving it here is the
 * exact place the three-month shift would be introduced.
 */
function parseMonthLabel(label: string, fiscalYear: number): number {
  return fiscalMonthFromCalendarLabel(label, fiscalYear);
}

/**
 * Parses the sheet.
 *
 * Rows with an empty 合计工时 are SKIPPED, not treated as zero. The template ships with
 * twelve months of blank lines and the operator fills in only the months that have closed;
 * reading a blank as 0 would write a zero baseline for a month that has not happened yet,
 * and zero is indistinguishable from a real total of zero on the dashboard.
 */
function parseCsv(text: string, fiscalYear: number): BaselineCell[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error("CSV 是空文件。");
  }
  const header = headerLine.split(",").map((h) => h.trim());
  if (header.length !== EXPECTED_HEADER.length) {
    throw new Error(
      `表头列数不对：读到 ${String(header.length)} 列，应为 ${String(EXPECTED_HEADER.length)} 列` +
        `（${EXPECTED_HEADER.join(",")}）`,
    );
  }
  for (const [index, expected] of EXPECTED_HEADER.entries()) {
    if (header[index] !== expected) {
      throw new Error(
        `第 ${String(index + 1)} 列表头应为「${expected}」，实际是「${header[index] ?? ""}」。` +
          "请不要改动模板表头。",
      );
    }
  }

  const cells: BaselineCell[] = [];
  for (const [index, raw] of lines.entries()) {
    if (index === 0 || raw.trim() === "") continue;
    const line = index + 1;
    const fields = raw.split(",").map((f) => f.trim());
    if (fields.length !== EXPECTED_HEADER.length) {
      throw new Error(
        `第 ${String(line)} 行有 ${String(fields.length)} 列，应为 ${String(EXPECTED_HEADER.length)} 列：${raw}`,
      );
    }
    const [departmentName = "", sectionName = "", monthLabel = "", hoursText = ""] = fields;
    if (hoursText === "") continue;

    const totalHours = Number(hoursText);
    if (!Number.isFinite(totalHours) || totalHours < 0) {
      throw new Error(
        `第 ${String(line)} 行合计工时非法：${JSON.stringify(hoursText)}（应为非负数字）`,
      );
    }
    if (departmentName === "" || sectionName === "") {
      throw new Error(`第 ${String(line)} 行部名或课名为空：${raw}`);
    }
    cells.push({
      line,
      departmentName,
      sectionName,
      monthLabel,
      month: parseMonthLabel(monthLabel, fiscalYear),
      totalHours,
    });
  }

  if (cells.length === 0) {
    throw new Error("CSV 里没有任何填了合计工时的行，没有可导入的数据。");
  }
  return cells;
}

/** Rejects the batch if any (课, 月) pair appears twice - one of them would win silently. */
function assertNoDuplicates(cells: readonly BaselineCell[]): void {
  const seen = new Map<string, number>();
  for (const cell of cells) {
    const key = `${cell.departmentName}/${cell.sectionName}/${String(cell.month)}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `重复数据：${cell.departmentName} / ${cell.sectionName} / ${cell.monthLabel} ` +
          `在第 ${String(first)} 行和第 ${String(cell.line)} 行各出现一次。请删掉多余的一行。`,
      );
    }
    seen.set(key, cell.line);
  }
}

/**
 * Maps every cell onto a Section id, or refuses the whole batch.
 *
 * Matching is on the exact (部名, 课名) pair, with no trimming beyond the field trim and no
 * fuzzy fallback. Two of these names differ only by a Japanese-vs-simplified character
 * (検査 / 检査) that renders almost identically, and a nearest-match guess would file a
 * whole month of hours under the wrong section while reporting success.
 */
async function resolveSectionIds(
  cells: readonly BaselineCell[],
): Promise<Map<string, string>> {
  const sections = await prisma.section.findMany({
    select: { id: true, name: true, department: { select: { name: true } } },
  });
  const byPair = new Map(sections.map((s) => [`${s.department.name}/${s.name}`, s.id]));

  const unknown = new Map<string, number>();
  for (const cell of cells) {
    const key = `${cell.departmentName}/${cell.sectionName}`;
    if (!byPair.has(key) && !unknown.has(key)) {
      unknown.set(key, cell.line);
    }
  }
  if (unknown.size > 0) {
    const detail = [...unknown.entries()]
      .map(([key, line]) => `  第 ${String(line)} 行：${key}`)
      .join("\n");
    throw new Error(
      `以下「部名/课名」在系统里找不到，本次一行也没有导入：\n${detail}\n\n` +
        `系统现有 ${String(byPair.size)} 个课：\n` +
        [...byPair.keys()].map((k) => `  ${k}`).join("\n") +
        "\n\n请把 CSV 里的名字改成与上面完全一致（包括繁简写法），再重新运行。",
    );
  }
  return byPair;
}

/** Groups the cells by fiscal month, for the reconciliation printout. */
function summariseByMonth(
  cells: readonly BaselineCell[],
  fiscalYear: number,
): { month: number; label: string; sections: number; totalHours: number }[] {
  const byMonth = new Map<number, { sections: number; totalHours: number }>();
  for (const cell of cells) {
    const bucket = byMonth.get(cell.month) ?? { sections: 0, totalHours: 0 };
    byMonth.set(cell.month, {
      sections: bucket.sections + 1,
      totalHours: bucket.totalHours + cell.totalHours,
    });
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([month, bucket]) => ({
      month,
      label: fiscalMonthLabel(fiscalYear, month),
      sections: bucket.sections,
      totalHours: Math.round(bucket.totalHours * 10) / 10,
    }));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const sourceFile = basename(options.file);

  const cells = parseCsv(readFileSync(options.file, "utf8"), options.year);
  assertNoDuplicates(cells);
  const sectionIdByPair = await resolveSectionIds(cells);

  const fiscalYear = await prisma.fiscalYear.findUnique({
    where: { year: options.year },
    select: { id: true, name: true },
  });
  if (fiscalYear === null) {
    throw new Error(
      `系统里没有 FY${String(options.year)} 这个财年，无法写入实绩。请先在管理页创建财年。`,
    );
  }

  const months = summariseByMonth(cells, options.year);
  const monthNumbers = months.map((m) => m.month);

  // What is already there, so the operator sees what this run REPLACES rather than only
  // what it adds. The July collision is the case that matters: that month holds one test
  // day's fold values, and their magnitude (one day, not one month) is the tell.
  const existing = await prisma.actual.groupBy({
    by: ["month", "source"],
    where: { fiscalYearId: fiscalYear.id, month: { in: monthNumbers } },
    _sum: { totalHours: true },
    _count: { _all: true },
  });

  console.log(`\n文件      : ${options.file}`);
  console.log(`财年      : ${fiscalYear.name}（--year ${String(options.year)}）`);
  console.log(`模式      : ${options.apply ? "写入（--apply）" : "试算（未加 --apply，不写库）"}`);
  console.log(`\n将写入 ${String(cells.length)} 个单元格，按月汇总：`);
  console.log("  财月  月份标签  课数    合计工时");
  for (const month of months) {
    console.log(
      `  ${String(month.month).padStart(2, " ")}    ${month.label}     ` +
        `${String(month.sections).padStart(2, " ")}    ${month.totalHours.toFixed(1).padStart(10, " ")}`,
    );
  }
  if (existing.length === 0) {
    console.log("\n这些月份当前没有任何实绩数据。");
  } else {
    console.log("\n这些月份当前已有的实绩（将被覆盖）：");
    for (const row of existing) {
      console.log(
        `  财月 ${String(row.month).padStart(2, " ")}  来源 ${row.source}  ` +
          `${String(row._count._all)} 行  合计 ${String(row._sum.totalHours ?? 0)}`,
      );
    }
  }

  if (!options.apply) {
    console.log(
      "\n试算结束，数据库未改动。核对上面的数字无误后，加 --apply 重新运行即可写入。",
    );
    return EXIT_OK;
  }

  const hadRows = existing.length > 0;
  const written = await writeMasterDataWithAudit(
    "actual_baseline",
    async (tx) => {
      let upserted = 0;
      for (const cell of cells) {
        const sectionId = sectionIdByPair.get(
          `${cell.departmentName}/${cell.sectionName}`,
        );
        if (sectionId === undefined) {
          // Unreachable - resolveSectionIds() rejected the batch on any gap. Kept because
          // skipping a cell here would produce a baseline that is short one section.
          throw new Error(
            `import-actual-baseline: 第 ${String(cell.line)} 行课别未解析`,
          );
        }
        // personnelHours / overtimeHours stay 0 on purpose: the 人员工时 / 加班工时 split
        // comes from per-employee columns that do not exist for these months, and inventing
        // a ratio would put a fabricated number on the same screen as measured ones.
        const mutable = {
          personnelHours: 0,
          overtimeHours: 0,
          totalHours: cell.totalHours,
          source: ACTUAL_SOURCE_MANUAL,
          sourceFile,
          fetchedAt: null,
        };
        const key = {
          sectionId,
          fiscalYearId: fiscalYear.id,
          month: cell.month,
        };
        await tx.actual.upsert({
          where: { sectionId_fiscalYearId_month: key },
          create: { ...key, ...mutable },
          update: mutable,
          select: { id: true },
        });
        upserted += 1;
      }

      // Any row in an imported month for a section the sheet does not mention is removed.
      // Otherwise a month declared "manual baseline" would keep a leftover fold figure for
      // one section, and that mixed month is exactly what the rebuild guard cannot
      // meaningfully protect: the dashboard would show a bar with no source anyone can name.
      const removed = await tx.actual.deleteMany({
        where: {
          fiscalYearId: fiscalYear.id,
          month: { in: monthNumbers },
          sectionId: { notIn: [...sectionIdByPair.values()] },
        },
      });
      return { upserted, removed: removed.count };
    },
    () => ({
      action: hadRows ? "update" : "create",
      targetKey: MASTER_DATA_ALL_TARGETS,
      reason:
        `FY${String(options.year)} 历史实绩基线补录：` +
        `${months.map((m) => m.label).join("、")}（来源文件 ${sourceFile}）`,
    }),
  );

  console.log(
    `\n已写入：upsert ${String(written.upserted)} 行，清理无对应课别的旧行 ${String(written.removed)} 行。`,
  );
  console.log("已记入 /admin/audit 审计留痕（entity = actual_baseline）。");
  return EXIT_OK;
}

// tsx cannot take top-level await in this project, hence the void-wrapped call. The
// disconnect runs in every branch: better-sqlite3 holds the dev.db file lock, and leaking
// it would block the next migration.
void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\n导入失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_FAILED;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
