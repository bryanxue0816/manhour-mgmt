// View-model assembly for the admin alert badge and the /admin/alerts page.
//
// Two layers on purpose:
//   - pure builders (buildAlertBadge / buildAlertsPageView) have no prisma/fs
//     import graph and are unit-tested directly;
//   - loaders do the IO and dynamically import the prisma-backed import-log repo
//     INSIDE the function body, so merely importing this module never constructs
//     the Prisma client (vitest runs with no DATABASE_URL and its client is built
//     at module top level).
//
// PII rule: view models carry recipient COUNTS only - no mailbox values, no
// credentials (tests/admin/alerts-view.test.ts asserts it on the serialised view).

import {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  describeImportStaleness,
  type ImportStaleness,
  type StalenessLevel,
} from "@/lib/attendance/import-staleness";
import {
  alertStatePathFor,
  readAlertState,
  type AlertState,
} from "@/lib/alerts/alert-state";
import { loadAlertEmailConfig, type AlertEmailConfig } from "@/lib/alerts/email-config";
import { formatBusinessTimestamp } from "@/lib/db/date";

export interface AlertBadgeView {
  tone: "ok" | "warn" | "danger";
  label: string;
  href: "/admin/alerts";
}

const BADGE_HREF = "/admin/alerts";

// Priority (spec 5.3.1): config-error > stale/never incident > dry-run > ok.
// During a dry-run a real staleness incident still shows the danger label.
export function buildAlertBadge(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
}): AlertBadgeView {
  const { config, staleness } = input;

  if (config.mode === "config-error") {
    return { tone: "danger", label: "告警通道配置错误", href: BADGE_HREF };
  }
  if (staleness.level === "never") {
    return { tone: "danger", label: "考勤数据告警中：从未有成功导入记录", href: BADGE_HREF };
  }
  if (staleness.level === "stale") {
    // daysSince is null only on an unparseable stored timestamp, which is still
    // an incident the operator must investigate.
    const label =
      staleness.daysSince === null
        ? "考勤数据告警中：末次成功导入时间戳无法解析"
        : `考勤数据告警中：已 ${String(staleness.daysSince)} 天未成功导入`;
    return { tone: "danger", label, href: BADGE_HREF };
  }
  if (config.mode === "dry-run") {
    return { tone: "warn", label: "告警通道：干跑中（不会真实发信）", href: BADGE_HREF };
  }
  return { tone: "ok", label: "告警通道：正常", href: BADGE_HREF };
}

export interface AlertsPageView {
  badge: AlertBadgeView;
  channel: {
    modeLabel: string;
    reasonLabel: string | null;
    recipientCount: number;
    forcedByEnv: boolean;
    configErrors: readonly string[];
  };
  judgement: {
    level: StalenessLevel;
    daysSince: number | null;
    /** Business-local formatted timestamp, or null when there has never been a success. */
    latestSuccessAt: string | null;
    message: string | null;
  };
  frequency: AlertState | null;
}

const MODE_LABELS: Record<AlertEmailConfig["mode"], string> = {
  live: "真实发送",
  "dry-run": "干跑",
  "config-error": "配置错误",
};

const DRY_RUN_REASON_LABELS = {
  "smtp-not-configured": "未配置 SMTP_HOST，系统自动进入干跑（配置后重启容器即转为真实发送）",
  "forced-by-env": "环境变量 ALERT_EMAIL_DRY_RUN=true 强制干跑",
} as const;

export function buildAlertsPageView(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
  now: Date;
}): AlertsPageView {
  const { config, staleness, latestSuccessAt, state } = input;
  return {
    badge: buildAlertBadge({ config, staleness }),
    channel: {
      modeLabel: MODE_LABELS[config.mode],
      reasonLabel:
        config.mode === "dry-run" ? DRY_RUN_REASON_LABELS[config.reason] : null,
      recipientCount: config.mode === "config-error" ? 0 : config.adminEmails.length,
      forcedByEnv: config.mode === "dry-run" && config.reason === "forced-by-env",
      configErrors: config.mode === "config-error" ? config.errors : [],
    },
    judgement: {
      level: staleness.level,
      daysSince: staleness.daysSince,
      latestSuccessAt:
        latestSuccessAt === null ? null : formatBusinessTimestamp(latestSuccessAt),
      message: staleness.message,
    },
    frequency: state,
  };
}

export async function loadAlertBadgeData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
} | null> {
  try {
    // Dynamic import: this edge pulls in the Prisma client, whose module top
    // level constructs a client and throws when DATABASE_URL is absent.
    const { findLatestSuccessfulImportLog } = await import("@/lib/db/import-log.repo");
    const config = loadAlertEmailConfig(process.env);
    const log = await findLatestSuccessfulImportLog();
    const latestSuccessAt = log === null ? null : log.importedAt;
    const staleness = describeImportStaleness(
      latestSuccessAt,
      new Date(),
      DEFAULT_STALENESS_THRESHOLD_DAYS,
    );
    return { config, staleness };
  } catch {
    return null;
  }
}

export async function loadAlertsPageData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
} | null> {
  try {
    const { findLatestSuccessfulImportLog } = await import("@/lib/db/import-log.repo");
    const config = loadAlertEmailConfig(process.env);
    const log = await findLatestSuccessfulImportLog();
    const latestSuccessAt = log === null ? null : log.importedAt;
    const now = new Date();
    const staleness = describeImportStaleness(
      latestSuccessAt,
      now,
      DEFAULT_STALENESS_THRESHOLD_DAYS,
    );
    const state = await readAlertState(alertStatePathFor(process.env.DATABASE_URL));
    return { config, staleness, latestSuccessAt, state };
  } catch {
    return null;
  }
}
