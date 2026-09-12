// The shared email transport for alert channels (phase 1: attendance staleness;
// phase 2 business-threshold alerts reuse this layer unchanged).
//
// Two implementations behind one interface:
//   - live:    nodemailer, one short-lived transport per script run; failures are
//              captured, sanitised and RETURNED - callers must never see a throw.
//   - dry-run: no transport; one single-line JSON log per delivery (address
//              values never logged) and a delivered/dryRun result.

import nodemailer from "nodemailer";

import type { DryRunEmailConfig, LiveEmailConfig } from "./email-config";

export interface SendEmailInput {
  to: string[];
  subject: string;
  text: string;
}

export interface SendEmailResult {
  delivered: boolean;
  dryRun: boolean;
  /** Sanitized, length-capped failure reason; never contains SMTP_PASS. */
  error?: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

const ERROR_MAX_LENGTH = 300;
const SECRET_PATTERN = /(pass(?:word)?|auth)\s*[=:]\s*\S+/gi;

/**
 * Strips credential-looking fragments and caps the length, so a provider error
 * like "535 auth failed for user relay pass hunter2" can land in alert-state
 * without leaking the password into the admin page.
 */
export function sanitizeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(SECRET_PATTERN, "$1=[redacted]").slice(0, ERROR_MAX_LENGTH);
}

export function createEmailSender(
  config: LiveEmailConfig | DryRunEmailConfig,
): EmailSender {
  if (config.mode === "dry-run") {
    return {
      send: async (input: SendEmailInput): Promise<SendEmailResult> => {
        // One JSON line, recipient COUNT only - addresses are PII in logs.
        console.log(
          JSON.stringify({
            evt: "alert-email-dry-run",
            toCount: input.to.length,
            subject: input.subject,
          }),
        );
        return { delivered: true, dryRun: true };
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user === null ? undefined : { user: config.user, pass: config.pass ?? "" },
  });

  return {
    send: async (input: SendEmailInput): Promise<SendEmailResult> => {
      try {
        await transport.sendMail({
          from: config.from,
          to: input.to.join(", "),
          subject: input.subject,
          text: input.text,
        });
        console.log(JSON.stringify({ evt: "alert-email-sent", toCount: input.to.length }));
        return { delivered: true, dryRun: false };
      } catch (error) {
        return {
          delivered: false,
          dryRun: false,
          error: sanitizeSmtpError(error),
        };
      }
    },
  };
}
