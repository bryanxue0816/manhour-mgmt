/**
 * D-124: how long it has been since attendance data last landed, and whether that is
 * long enough to warn about.
 *
 * COUNTED IN CALENDAR DAYS, NOT WORKING DAYS. D-124 originally said 「连续 2 个工作日无新
 * 文件」, but D-168 revoked WorkCalendar, so there is no working-day predicate left to count
 * with. N=3 calendar days is the replacement because it clears the longest gap a healthy
 * pipeline produces: a Friday upload followed by nothing over the weekend is 3 days old by
 * Monday morning and must not shout. Anything beyond that is a real gap.
 *
 * A rest-day report legitimately resets the clock. Under D-170 a file with no employee rows
 * is a SUCCESS with rowCount=0 - it is positive evidence that HR published and the pipeline
 * ran, which is exactly what this check is asking about. It is NOT evidence that hours were
 * worked, but nothing here claims that.
 *
 * Pure and prisma-free so the thresholds can be tested without a database. The caller
 * supplies `now`; reading the clock in here would make every assertion depend on when the
 * suite happened to run.
 */
import { businessDayOf } from "@/lib/db/date";

/** Calendar days of silence tolerated before the banner appears. See the module note. */
export const DEFAULT_STALENESS_THRESHOLD_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/**
 * `ok` — data arrived recently enough; nothing to show.
 * `stale` — no successful import for at least the threshold; show the warning.
 * `never` — nothing has ever imported successfully, which is a different problem with a
 *   different fix (start uploading) and so gets its own state rather than an enormous
 *   day count.
 */
export type StalenessLevel = "ok" | "stale" | "never";

export interface ImportStaleness {
  level: StalenessLevel;
  /** Calendar days since the last success, or null when there has never been one. */
  daysSince: number | null;
  /** Operator-facing sentence. Null only when `level` is "ok". */
  message: string | null;
}

/**
 * Judges the freshness of the most recent SUCCESSFUL import.
 *
 * Takes the latest SUCCESS, not the latest attempt of any status. The two answer different
 * questions and /actuals already shows the latter: a FAILED attempt five minutes ago does
 * not make the stored data any fresher, and treating it as a heartbeat would silence this
 * warning precisely when the pipeline is broken.
 *
 * @param latestSuccessAt timestamp of the last SUCCESS, or null if there is none.
 * @param now the current instant, supplied by the caller.
 * @param thresholdDays calendar days of silence before warning. Must be a positive integer.
 * @throws if `thresholdDays` is not a positive integer, or `now` is an invalid Date.
 */
export function describeImportStaleness(
  latestSuccessAt: Date | null,
  now: Date,
  thresholdDays: number = DEFAULT_STALENESS_THRESHOLD_DAYS,
): ImportStaleness {
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1) {
    throw new Error(
      `Invalid staleness threshold: ${String(thresholdDays)} (expected a positive integer)`,
    );
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid Date: cannot judge import staleness against an unknown now");
  }

  if (latestSuccessAt === null) {
    return {
      level: "never",
      daysSince: null,
      message: "从未成功导入过考勤数据，本页的实绩工时为空或来自初始化数据。",
    };
  }
  if (Number.isNaN(latestSuccessAt.getTime())) {
    // A corrupt stored timestamp is itself a reason to look at the import log, and
    // silently treating it as "fresh" would hide both problems at once.
    return {
      level: "stale",
      daysSince: null,
      message: "最近一次成功导入的时间戳无法解析，请检查导入日志。",
    };
  }

  // Both ends projected onto business-local calendar days before subtracting, so the
  // answer is "how many dates have turned over", not "how many 24-hour periods elapsed".
  // Without this, a 06:00 upload compared against 05:00 the next morning would round to
  // 0 days and a genuinely missing day would read as fresh.
  const daysSince = Math.round(
    (businessDayOf(now).getTime() - businessDayOf(latestSuccessAt).getTime()) / MS_PER_DAY,
  );

  // A future timestamp is a clock-skew or bad-data problem, not freshness. Clamping to 0
  // keeps it out of the warning while leaving the negative value invisible to callers.
  if (daysSince < thresholdDays) {
    return { level: "ok", daysSince: Math.max(daysSince, 0), message: null };
  }

  return {
    level: "stale",
    daysSince,
    message:
      `已连续 ${String(daysSince)} 天没有成功导入考勤数据` +
      `（阈值 ${String(thresholdDays)} 天）。下方实绩工时可能缺少最近几天的数据，请尽快上传。`,
  };
}
