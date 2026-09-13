#!/usr/bin/env bash
# Twice-daily attendance staleness alert check. Runs INSIDE the app container so
# it shares DATABASE_URL / SMTP_* from env_file and the /app/data bind mount.
# Exits non-zero if the container is down - the host cron MAIL/log then records it,
# which is the whole point of keeping the alarm outside the container.
set -euo pipefail

# Compose project directory - kept identical to the existing fetch wrapper.
# VERIFY against /opt/manhour-mgmt/scripts/fetch-attendance.sh at deploy time.
cd /opt/manhour-mgmt

docker compose exec -T app \
  node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
