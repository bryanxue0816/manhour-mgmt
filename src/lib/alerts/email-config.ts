// Environment -> alert email channel configuration, resolved at the USE POINT
// (script startup, test-action invocation), never at Next.js startup. Three
// outcomes: a fully validated live config, an explicit/implicit dry-run, or a
// config-error carrying every problem found in one pass.

import { isLikelyEmailAddress } from "@/lib/validation/email";

export interface LiveEmailConfig {
  mode: "live";
  host: string;
  port: number;
  /** true = implicit TLS (nodemailer "secure", port 465 style); false = STARTTLS-optional. */
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  adminEmails: string[];
}

export interface DryRunEmailConfig {
  mode: "dry-run";
  reason: "smtp-not-configured" | "forced-by-env";
  adminEmails: string[];
}

export interface ConfigErrorEmailConfig {
  mode: "config-error";
  /** All problems found in one pass, so the operator fixes everything at once. */
  errors: string[];
}

export type AlertEmailConfig =
  | LiveEmailConfig
  | DryRunEmailConfig
  | ConfigErrorEmailConfig;

const DEFAULT_SMTP_PORT = 25;
const MAX_ADMIN_RECIPIENTS = 3;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Splits the comma list, trims, drops empties, and partitions valid shapes from
 * invalid ones. Used strictly (live mode) and best-effort (dry-run mode, where
 * invalid entries are silently discarded).
 */
function parseAdminEmails(raw: string | undefined): {
  valid: string[];
  hasInvalid: boolean;
} {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const valid = entries.filter((entry) => isLikelyEmailAddress(entry));
  return { valid, hasInvalid: valid.length !== entries.length };
}

function parseBooleanFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

export function loadAlertEmailConfig(env: NodeJS.ProcessEnv): AlertEmailConfig {
  const forcedDryRun = (env.ALERT_EMAIL_DRY_RUN ?? "").trim().toLowerCase() === "true";
  if (forcedDryRun) {
    // Highest precedence: even a half-configured SMTP block must not error here.
    const { valid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
    return {
      mode: "dry-run",
      reason: "forced-by-env",
      adminEmails: valid.slice(0, MAX_ADMIN_RECIPIENTS),
    };
  }

  const host = (env.SMTP_HOST ?? "").trim();
  if (host === "") {
    // Implicit dry-run so the pipeline can ship before IT provides SMTP (D-210).
    const { valid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
    return {
      mode: "dry-run",
      reason: "smtp-not-configured",
      adminEmails: valid.slice(0, MAX_ADMIN_RECIPIENTS),
    };
  }

  const errors: string[] = [];

  const from = (env.SMTP_FROM ?? "").trim();
  if (from === "") {
    errors.push("SMTP_FROM 未配置或为空，必须显式指定发件地址。");
  }

  const { valid: recipients, hasInvalid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
  if (recipients.length === 0) {
    errors.push("ALERT_ADMIN_EMAIL 必须配置至少 1 个收件人。");
  } else if (recipients.length > MAX_ADMIN_RECIPIENTS) {
    errors.push(
      `ALERT_ADMIN_EMAIL 收件人最多 ${String(MAX_ADMIN_RECIPIENTS)} 个，当前 ${String(recipients.length)} 个。`,
    );
  }
  if (hasInvalid) {
    errors.push("ALERT_ADMIN_EMAIL 中存在格式不合法的邮箱地址。");
  }

  const user = (env.SMTP_USER ?? "").trim();
  const password = (env.SMTP_PASS ?? "").trim();
  if ((user === "") !== (password === "")) {
    errors.push("SMTP_USER 与 SMTP_PASS 必须同时配置（认证）或同时留空（免认证）。");
  }

  let port = DEFAULT_SMTP_PORT;
  const portRaw = env.SMTP_PORT;
  if (portRaw !== undefined && portRaw.trim() !== "") {
    const parsed = Number(portRaw.trim());
    if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
      errors.push(`SMTP_PORT 必须是 ${String(MIN_PORT)}-${String(MAX_PORT)} 之间的整数。`);
    } else {
      port = parsed;
    }
  }

  let secure = false;
  const secureFlag = parseBooleanFlag(env.SMTP_SECURE);
  if (secureFlag === null) {
    errors.push("SMTP_SECURE 只接受 true 或 false（缺省为 false）。");
  } else {
    secure = secureFlag;
  }

  if (errors.length > 0) {
    // Never silently downgrade to dry-run once SMTP_HOST claims to be configured.
    return { mode: "config-error", errors };
  }

  return {
    mode: "live",
    host,
    port,
    secure,
    user: user === "" ? null : user,
    pass: password === "" ? null : password,
    from,
    adminEmails: recipients,
  };
}
