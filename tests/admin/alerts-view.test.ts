import { describe, expect, it } from "vitest";

import { buildAlertBadge, buildAlertsPageView } from "@/app/admin/alerts/alerts-summary";
import type { AlertEmailConfig } from "@/lib/alerts/email-config";
import type { ImportStaleness } from "@/lib/attendance/import-staleness";

const OK: ImportStaleness = { level: "ok", daysSince: 0, message: null };
const STALE: ImportStaleness = { level: "stale", daysSince: 5, message: "已超过 3 天" };
const NEVER: ImportStaleness = { level: "never", daysSince: null, message: "从未导入" };
const live = (over: Partial<AlertEmailConfig> = {}): AlertEmailConfig =>
  ({ mode: "live", host: "h", port: 25, secure: false, user: null, pass: null, from: "s@x.com", adminEmails: ["a@x.com"], ...over }) as AlertEmailConfig;
const dry = (): AlertEmailConfig => ({ mode: "dry-run", reason: "smtp-not-configured", adminEmails: [] });

describe("buildAlertBadge", () => {
  it("shows a healthy channel in plan tone", () => {
    expect(buildAlertBadge({ config: live(), staleness: OK })).toMatchObject({
      tone: "ok",
      label: "告警通道：正常",
    });
  });

  it("warns that dry-run is not real protection", () => {
    expect(buildAlertBadge({ config: dry(), staleness: OK }).label).toBe(
      "告警通道：干跑中（不会真实发信）",
    );
  });

  it("reports the incident day count while stale", () => {
    expect(buildAlertBadge({ config: live(), staleness: STALE }).label).toContain("已 5 天");
  });

  it("has wording for never-imported systems", () => {
    expect(buildAlertBadge({ config: live(), staleness: NEVER }).label).toContain("从未有成功导入记录");
  });

  it("puts config errors above every other state", () => {
    const badge = buildAlertBadge({
      config: { mode: "config-error", errors: ["x"] },
      staleness: STALE,
    });
    expect(badge).toMatchObject({ tone: "danger", label: "告警通道配置错误" });
  });
});

describe("buildAlertsPageView PII masking", () => {
  it("never carries mailbox values or credentials into the view model", () => {
    const view = buildAlertsPageView({
      config: live({ pass: "super-secret", adminEmails: ["ops@cn.denso.com", "boss@cn.denso.com"] }),
      staleness: STALE,
      latestSuccessAt: new Date("2026-09-05T01:07:00.000Z"),
      state: null,
      now: new Date("2026-09-11T01:20:00.000Z"),
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("super-secret");
    expect(view.channel.recipientCount).toBe(2);
  });
});
