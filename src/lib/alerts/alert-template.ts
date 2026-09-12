// Chinese plain-text email bodies for the attendance staleness channel.
// Pure functions: every timestamp goes through formatBusinessTimestamp so the
// Asia/Shanghai zone pin lives in exactly one place. No HTML, no attachments,
// no links (phase 1 deliberately needs no APP_BASE_URL).

import { formatBusinessTimestamp } from "@/lib/db/date";

import type { StalenessLevel } from "@/lib/attendance/import-staleness";

export interface AlertEmailContent {
  subject: string;
  text: string;
}

const NO_REPLY_FOOTER = "此邮件由系统自动发送，请勿回复。";

const STALE_CONVENTION =
  "口径说明：PARTIAL（部分成功）视为成功；仅有汇总行、数据行数为 0 的文件也视为成功。距上次成功导入超过 3 个自然日即触发本邮件。";

const STALE_TROUBLESHOOTING = [
  "请按以下顺序排查：",
  "1. 宿主机的考勤抓取定时任务（crontab）是否仍在运行；",
  "2. HR 共享目录挂载 /mnt/hr 是否可访问（目录不可达时系统内不会留下导入记录）；",
  "3. 应用容器状态与数据卷磁盘空间是否正常；",
  "4. 登录后台 /admin/audit 查看最近的主数据快照，并在实际数据页查看最近的导入日志。",
].join("\n");

export function buildStaleAlertEmail(input: {
  level: StalenessLevel;
  daysSince: number | null;
  latestSuccessAt: Date | null;
  now: Date;
}): AlertEmailContent {
  const isNever = input.level === "never";
  const subject = isNever
    ? "［工时管理系统］考勤数据停摆告警：从未有成功导入考勤数据记录"
    : `［工时管理系统］考勤数据停摆告警：已 ${String(input.daysSince)} 天未成功导入考勤数据`;

  const lastSuccessLine = isNever
    ? "末次成功导入时间：无（系统从未有过成功导入记录）"
    : `末次成功导入时间：${formatBusinessTimestamp(input.latestSuccessAt as Date)}`;
  const gapLine = isNever
    ? "系统从未有过成功导入记录。"
    : `距今天数：${String(input.daysSince)} 天（按 Asia/Shanghai 时区的自然日计算）`;

  const text = [
    "管理员您好：",
    "",
    "工时管理系统检测到考勤数据导入已停摆。",
    "",
    lastSuccessLine,
    gapLine,
    `本邮件生成时间：${formatBusinessTimestamp(input.now)}`,
    "",
    STALE_CONVENTION,
    "",
    STALE_TROUBLESHOOTING,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return { subject, text };
}

export function buildRecoveryEmail(input: {
  latestSuccessAt: Date;
  now: Date;
}): AlertEmailContent {
  const text = [
    "管理员您好：",
    "",
    "工时管理系统的考勤数据导入已恢复正常。",
    "",
    `恢复后末次成功导入时间：${formatBusinessTimestamp(input.latestSuccessAt)}`,
    `本邮件生成时间：${formatBusinessTimestamp(input.now)}`,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return { subject: "［工时管理系统］考勤数据导入已恢复正常", text };
}

export function buildTestEmail(input: {
  now: Date;
  dryRun: boolean;
  recipientCount: number;
}): AlertEmailContent {
  const generatedAt = formatBusinessTimestamp(input.now);
  const modeLine = input.dryRun
    ? "发送模式：干跑（dry-run，仅写入容器日志，不会真实投递）"
    : "发送模式：真实发送";
  const text = [
    "管理员您好：",
    "",
    "这是一封告警邮件通道测试邮件，用于验证 SMTP 配置是否可用。",
    modeLine,
    `收件人数量：${String(input.recipientCount)}`,
    `本邮件生成时间：${generatedAt}`,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return {
    subject: `［工时管理系统］告警邮件通道测试（${generatedAt}）`,
    text,
  };
}
