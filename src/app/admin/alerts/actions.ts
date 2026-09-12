// Server Action for the "send test email" button on /admin/alerts.
//
// Boundary rules (same as every admin action):
//   - requireAdmin() MUST be the first statement. Path/middleware/nav checks
//     are all bypassable (POSTs can hit the action directly); only the in-body
//     check is load-bearing.
//   - Test sends deliberately do NOT touch alert-state.json: they must not
//     advance firstAlertDate / lastAlertDate or suppress a real alert.
//   - The sanitised failure detail stays in container logs. The redirect query
//     carries only the outcome enum, never error text.

"use server";

import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth";
import { buildTestEmail } from "@/lib/alerts/alert-template";
import { loadAlertEmailConfig } from "@/lib/alerts/email-config";
import type { DryRunEmailConfig, LiveEmailConfig } from "@/lib/alerts/email-config";
import { createEmailSender, type EmailSender } from "@/lib/alerts/email-sender";

// Unlike the short-lived cron script, the Next server process is long-lived, so
// the transport is built lazily once and reused. Config comes from process env
// and only changes on container restart.
let cachedSender: EmailSender | null = null;

function senderFor(config: LiveEmailConfig | DryRunEmailConfig): EmailSender {
  if (cachedSender === null) {
    cachedSender = createEmailSender(config);
  }
  return cachedSender;
}

export async function sendTestAlertEmailAction(): Promise<void> {
  // Erratum P: requireAdmin() RETURNS the verdict, it never throws (see
  // src/lib/auth.ts). A bare `await requireAdmin();` would compile but enforce
  // nothing: a direct unauthenticated POST falls through to the real send.
  // Branch on gate.ok like every other admin action. The ten existing actions
  // `return reject(gate.message)` for a client useActionState consumer; this is
  // a no-argument native <form action> with no return-value consumer and four
  // redirect() exits already, so the denied branch redirects to the login form
  // (the `from` target is a fixed site-relative path validated again by the
  // login action's safeDestination - no open redirect).
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(`/login?from=${encodeURIComponent("/admin/alerts")}`);
  }

  const config = loadAlertEmailConfig(process.env);
  if (config.mode === "config-error") {
    redirect("/admin/alerts?test=config-error");
  }

  const mail = buildTestEmail({
    now: new Date(),
    dryRun: config.mode === "dry-run",
    recipientCount: config.adminEmails.length,
  });
  const result = await senderFor(config).send({
    to: config.adminEmails,
    subject: mail.subject,
    text: mail.text,
  });

  if (result.dryRun) redirect("/admin/alerts?test=dry-run");
  if (result.delivered) redirect("/admin/alerts?test=sent");
  redirect("/admin/alerts?test=error");
}
