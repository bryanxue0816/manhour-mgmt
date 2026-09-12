import { describe, expect, it } from "vitest";

import {
  buildRecoveryEmail,
  buildStaleAlertEmail,
  buildTestEmail,
} from "@/lib/alerts/alert-template";

const NOW = new Date("2026-09-11T01:20:00.000Z");
const LAST = new Date("2026-09-05T01:07:00.000Z");

describe("alert templates", () => {
  it("renders the stale subject with the day count", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.subject).toBe("［工时管理系统］考勤数据停摆告警：已 5 天未成功导入考勤数据");
  });

  it("states the never-imported situation without a day count", () => {
    const mail = buildStaleAlertEmail({ level: "never", daysSince: null, latestSuccessAt: null, now: NOW });

    expect(mail.text).toContain("系统从未有过成功导入记录");
    expect(mail.text).not.toContain("距今天数：");
  });

  it("includes the formatted last-success time and generation time", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("末次成功导入时间：2026/09/05 09:07");
    expect(mail.text).toContain("本邮件生成时间：2026/09/11 09:20");
  });

  it("documents the PARTIAL and zero-row success convention", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("PARTIAL");
    expect(mail.text).toContain("数据行数为 0");
  });

  it("lists the four troubleshooting stops and the no-reply footer", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("crontab");
    expect(mail.text).toContain("/mnt/hr");
    expect(mail.text).toContain("数据卷磁盘");
    expect(mail.text).toContain("/admin/audit");
    expect(mail.text).toContain("此邮件由系统自动发送，请勿回复");
  });

  it("renders the exact recovery subject", () => {
    expect(buildRecoveryEmail({ latestSuccessAt: LAST, now: NOW }).subject).toBe(
      "［工时管理系统］考勤数据导入已恢复正常",
    );
  });

  it("renders the test subject with a formatted timestamp", () => {
    const mail = buildTestEmail({ now: NOW, dryRun: false, recipientCount: 2 });

    expect(mail.subject).toBe("［工时管理系统］告警邮件通道测试（2026/09/11 09:20）");
    expect(mail.text).toContain("收件人数量：2");
  });

  it("states dry-run delivery in the test body", () => {
    const mail = buildTestEmail({ now: NOW, dryRun: true, recipientCount: 0 });

    expect(mail.text).toContain("干跑");
    expect(mail.text).toContain("不会真实投递");
  });
});
