// Attendance staleness alert entry point (phase 1 walking skeleton).
//
// Run (local, env from .env):
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
// Run (production container, via deploy/cron/check-attendance-alert.sh):
//   docker compose -f docker-compose.prod.yml exec -T app \
//     node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
//
// Exit codes (the host cron wrapper records them; see alert-service.ts):
//   0 scan completed: healthy skip, baseline grace, dry run, or a successful send
//   1 configuration error, or a live send failed
//   2 database read failed, or alert-state.json could not be written
//
// This is a thin shell: every decision is unit-tested in src/lib/alerts. The
// shell only wires the production implementations (prisma, real fs, nodemailer)
// into runAttendanceAlertCheck's injected dependencies.

import {
  alertStatePathFor,
  readAlertState,
  writeAlertState,
} from "../src/lib/alerts/alert-state";
import { runAttendanceAlertCheck } from "../src/lib/alerts/alert-service";
import { loadAlertEmailConfig } from "../src/lib/alerts/email-config";
import { createEmailSender } from "../src/lib/alerts/email-sender";
import { findLatestSuccessfulImportLog } from "../src/lib/db/import-log.repo";
import { prisma } from "../src/lib/prisma";

// Unexpected throw outside the orchestrated failure matrix (defensive): treat
// as infrastructure trouble, same class as a database failure.
const EXIT_INFRA = 2;

/** Plain-text first line for human cron logs / docker logs, before JSON lines. */
function printBanner(config: ReturnType<typeof loadAlertEmailConfig>): void {
  if (config.mode === "live") {
    console.log(
      `[attendance-alert] MODE=LIVE recipients=${String(config.adminEmails.length)}`,
    );
    return;
  }
  if (config.mode === "dry-run") {
    console.log(
      `[attendance-alert] MODE=DRY-RUN reason=${config.reason} recipients=${String(config.adminEmails.length)}`,
    );
    return;
  }
  console.log(
    `[attendance-alert] MODE=CONFIG-ERROR errors=${String(config.errors.length)}`,
  );
}

async function main(): Promise<number> {
  const config = loadAlertEmailConfig(process.env);
  printBanner(config);

  const stateFile = alertStatePathFor(process.env.DATABASE_URL);
  const sender = createEmailSender(config);

  const result = await runAttendanceAlertCheck({
    now: () => new Date(),
    config,
    findLatestSuccessAt: async () => {
      const log = await findLatestSuccessfulImportLog();
      return log === null ? null : log.importedAt;
    },
    readState: () => readAlertState(stateFile),
    writeState: (state) => writeAlertState(stateFile, state),
    send: (input) => sender.send(input),
    log: (record) => console.log(JSON.stringify(record)),
  });

  return result.exitCode;
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        evt: "scan-fatal",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = EXIT_INFRA;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
