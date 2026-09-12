import { describe, expect, it } from "vitest";

import { loadAlertEmailConfig } from "@/lib/alerts/email-config";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Next 16 types NODE_ENV as a required readonly field on NodeJS.ProcessEnv.
  return { ...overrides, NODE_ENV: "test" };
}

describe("loadAlertEmailConfig", () => {
  it("falls back to implicit dry-run when SMTP_HOST is absent", () => {
    const config = loadAlertEmailConfig(env());

    expect(config).toMatchObject({ mode: "dry-run", reason: "smtp-not-configured" });
    if (config.mode === "dry-run") expect(config.adminEmails).toEqual([]);
  });

  it("lets forced dry-run override a fully configured live setup", () => {
    const config = loadAlertEmailConfig(
      env({
        ALERT_EMAIL_DRY_RUN: "true",
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "a@cn.denso.com",
        ALERT_ADMIN_EMAIL: "b@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({ mode: "dry-run", reason: "forced-by-env" });
  });

  it("parses the force flag case-insensitively after trimming", () => {
    const config = loadAlertEmailConfig(env({ ALERT_EMAIL_DRY_RUN: " True " }));

    expect(config.mode).toBe("dry-run");
  });

  it("builds a live config with default port, no TLS and no auth", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: "ops@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({
      mode: "live",
      host: "mail.internal",
      port: 25,
      secure: false,
      user: null,
      pass: null,
    });
  });

  it("parses explicit port, secure flag and credentials", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_PORT: "465",
        SMTP_SECURE: "TRUE",
        SMTP_USER: "relay",
        SMTP_PASS: "secret",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: "ops@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({ mode: "live", port: 465, secure: true, user: "relay" });
  });

  it("splits, trims and caps the admin recipient list at three", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: " a@cn.denso.com, b@cn.denso.com ,c@cn.denso.com",
      }),
    );

    if (config.mode !== "live") throw new Error("expected live config");
    expect(config.adminEmails).toEqual([
      "a@cn.denso.com",
      "b@cn.denso.com",
      "c@cn.denso.com",
    ]);
  });

  // Base carries HOST only; each row supplies exactly the keys its scenario needs,
  // so "missing sender" really means missing.
  const sender = { SMTP_FROM: "sys@x.com" };
  const oneRecipient = { ALERT_ADMIN_EMAIL: "a@x.com" };

  it.each([
    ["four recipients", { ...sender, ALERT_ADMIN_EMAIL: "a@x.com,b@x.com,c@x.com,d@x.com" }],
    ["a malformed recipient", { ...sender, ALERT_ADMIN_EMAIL: "not-an-email" }],
    ["missing recipients", { ...sender }],
    ["missing sender", { ...oneRecipient }],
    ["a non-numeric port", { ...sender, ...oneRecipient, SMTP_PORT: "smtp" }],
    ["an out-of-range port", { ...sender, ...oneRecipient, SMTP_PORT: "500000" }],
    ["a bad secure flag", { ...sender, ...oneRecipient, SMTP_SECURE: "yes" }],
    ["username without password", { ...sender, ...oneRecipient, SMTP_USER: "relay" }],
    ["password without username", { ...sender, ...oneRecipient, SMTP_PASS: "secret" }],
  ] as const)("reports config-error for %s", (_label, extra) => {
    const config = loadAlertEmailConfig(env({ SMTP_HOST: "mail.internal", ...extra }));

    expect(config.mode).toBe("config-error");
  });

  it("accumulates every error instead of stopping at the first", () => {
    const config = loadAlertEmailConfig(env({ SMTP_HOST: "mail.internal", SMTP_PORT: "bad" }));

    if (config.mode !== "config-error") throw new Error("expected config-error");
    expect(config.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps best-effort parsed recipients in forced dry-run without erroring", () => {
    const config = loadAlertEmailConfig(
      env({ ALERT_EMAIL_DRY_RUN: "true", ALERT_ADMIN_EMAIL: "good@x.com, garbage" }),
    );

    if (config.mode !== "dry-run") throw new Error("expected dry-run");
    expect(config.adminEmails).toEqual(["good@x.com"]);
  });

  it("treats a whitespace-only host as unconfigured", () => {
    expect(loadAlertEmailConfig(env({ SMTP_HOST: "   " })).mode).toBe("dry-run");
  });
});
