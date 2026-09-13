# Production image for the man-hour management app.
#
# ============================================================================
# NOT VERIFIED ON A MACHINE. Read this before trusting it.
# ============================================================================
# Docker is not installed on the development host this file was written on
# (`docker` is absent; there is no Docker service). Nothing below has been
# built or run. It is written from facts measured on the host - addon layout,
# trace output, build-time database independence - but the first real build
# WILL surface something. Budget time for it. Every claim that could not be
# verified is marked "unverified" at the point it is made.
#
# ============================================================================
# Why three stages
# ============================================================================
# deps    - installs node_modules once, cached on package*.json alone.
# builder - runs prisma generate + next build, producing .next/standalone.
# runner  - copies only the standalone output plus a minimal ops toolchain.
#
# ============================================================================
# The native-addon problem, and why this is simpler than it looks
# ============================================================================
# better-sqlite3 is a native addon. The host's .node files are PE/Windows
# binaries (verified: magic 4d5a9000), so they can never be copied into a Linux
# image - hence a real install inside the image rather than a COPY of
# node_modules.
#
# But better-sqlite3@13 ships prebuilt binaries for linux-x64, linuxmusl-x64,
# and the arm64 pair (verified: prebuilds/linux-x64.node is ELF, 2.1 MB), and
# lib/binding.js selects one at runtime, detecting musl via
# process.report.getReport().header.glibcVersionRuntime. Its only dependency is
# node-addon-api, a header-only build-time package. So on linux-x64 NO
# COMPILATION HAPPENS AT ALL - no python3, no make, no g++.
#
# There is one wrinkle, and it is the reason this file pins a Debian base
# rather than Alpine. @prisma/adapter-better-sqlite3@7.9.1 declares
# `better-sqlite3: ^12.6.0`, while package.json asks for ^13.0.2. npm resolves
# that conflict by nesting a SECOND copy at
#   node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3
# at version 12.11.1 (verified on the host), and v12 has NO prebuilds directory
# - its install script is `prebuild-install || node-gyp rebuild --release`.
# The nested copy is the one the adapter actually loads: the traced addon on
# the host lives under that nested path, and there is no top-level
# build/Release at all.
#
# So the addon that matters is v12, obtained by prebuild-install downloading a
# release asset from GitHub. Two consequences:
#
#   1. The build host needs outbound HTTPS to github.com. On an air-gapped
#      build machine prebuild-install fails over to node-gyp, which is why the
#      toolchain is installed in `deps` anyway - it is insurance, not routine
#      cost. (unverified: whether prebuild-install resolves a matching asset
#      for Node 24 / ABI 137. If it does not, the node-gyp fallback runs and
#      the toolchain is load-bearing. This is the single most likely first-build
#      failure.)
#   2. Alpine/musl would need the linuxmusl asset AND musl-dev; Debian slim
#      matches the mainstream prebuild target. Not worth the size saving here.
#
# ============================================================================
# Node version
# ============================================================================
# The host runs Node 24.15.0 (ABI 137). package.json declares
# `engines.node: ">=24.0.0"`, but that is documentation only: npm ignores it
# unless engine-strict=true, and no .npmrc in this repo or on the host sets it.
# So this ARG remains the only pin that actually decides which Node runs in
# production. Keep it aligned with the host: a native addon compiled for one
# ABI will not load on another, and the failure message ("was compiled against
# a different Node.js version") is clear but only after a deploy.
#
# The `engines` range is deliberately wider than this pin (>=24 vs 24.15.0) but
# narrower than the dependency tree's true intersection (^22.12 || >=24.0):
# Node 22 has never been exercised on this project, so declaring it supported
# would assert a compatibility nobody verified.
ARG NODE_VERSION=24.15.0

# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Build toolchain for the node-gyp fallback path described above. If
# prebuild-install succeeds these packages go unused, but they must be present
# BEFORE npm ci, because npm ci runs the install scripts.
#
# rm -rf /var/lib/apt/lists/* in the same layer: apt lists are ~40 MB and
# deleting them in a later RUN would not shrink the image, only add a layer.
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so this layer is reused whenever application
# source changes but dependencies do not.
COPY package.json package-lock.json ./

# `npm ci` not `npm install`: ci honours the lockfile exactly and fails if
# package.json and the lock disagree, which is the behaviour a release build
# wants. Dev dependencies ARE needed here - the build stage runs
# `prisma generate` (prisma is a devDependency) and `next build` (typescript,
# tailwind, postcss are all devDependencies).
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NO DATABASE_URL IS SET, DELIBERATELY.
#
# Verified on the host: `next build` succeeds with DATABASE_URL unset, and also
# with it pointing at a nonexistent path - all six business routes are `ƒ`
# (server-rendered on demand), so not one of them queries the database during
# the build. Only /_not-found is prerendered.
#
# This matters for more than tidiness. If a build-time DATABASE_URL were
# required, the natural mistake would be to pass the production one as a build
# ARG, and build args are recorded in image history where anyone with the image
# can read them.
#
# `prisma generate` likewise needs no database connection (verified: exit 0
# with DATABASE_URL unset). It emits TypeScript into src/generated/prisma,
# which next build then compiles - so it must run first, not after.
ENV NEXT_TELEMETRY_DISABLED=1
RUN node node_modules/prisma/build/index.js generate
RUN node node_modules/next/dist/bin/next build

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The app formats every business date through Intl with an explicit
# timeZone: "Asia/Shanghai" (src/lib/db/date.ts BUSINESS_TIME_ZONE), so
# correctness does not depend on the container clock. TZ is set anyway so that
# log timestamps and backup filenames - backup-db.mjs stamps in LOCAL time on
# purpose - match what an operator sees on the host. A UTC container would
# write a file named 20:00 for a job that ran at 04:00 the next morning.
#
# Requires tzdata; node:bookworm-slim includes it. (unverified)
ENV TZ=Asia/Shanghai

# Run as a non-root user. node:* images ship an unprivileged `node` user
# (uid 1000), so no useradd is needed. USER is switched at the END of this
# stage, not here: WORKDIR creates /app owned by root, so an unprivileged
# `mkdir /app/data` would fail with EACCES. Ownership is handed over once, in
# one place, below.
#
# The uid matters at deploy time too: dev.db is bind-mounted from the host, and
# SQLite needs WRITE permission on both the file AND its directory (it creates a
# -journal sidecar next to the file - the database runs in journal_mode=delete,
# verified on the live file, not WAL). If the host directory is not writable by
# uid 1000, every write fails with SQLITE_CANTOPEN and - this is the dangerous
# part - org-source.ts classifies that as an infrastructure error and silently
# degrades to demo data with HTTP 200. See docs/DEPLOY.md.

# Standalone output. Next traces the runtime dependency graph into
# .next/standalone/node_modules (26.7 MB / 1351 files on the host, versus
# 929 MB for the full tree), and emits a server.js that chdir()s to its own
# directory and starts the server.
COPY --from=builder --chown=node:node /app/.next/standalone ./

# .next/static is NOT included in standalone output - Next excludes it by
# design (verified: .next/standalone/.next contains manifests and server/ but
# no static/). Omitting this line yields pages that render with every asset
# 404ing, which reads like a broken stylesheet rather than a missing-files bug.
#
# There is no public/ directory in this project, so there is nothing else to
# copy. If one is ever added, it needs a line here too.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# ---------------------------------------------------------------------------
# Ops toolchain: migrations, seeding, backups
# ---------------------------------------------------------------------------
# prisma/ is NOT traced into standalone output - nothing in the request path
# imports the schema. It is copied here so that `prisma migrate deploy` can run
# inside this image at release time instead of needing a separate toolbox
# container with its own copy of the schema.
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# The Prisma CLI and its engines, plus dotenv (prisma.config.ts does
# `import "dotenv/config"`) and tsx (prisma.config.ts is TypeScript, and the
# seed script is too). Roughly 65 MB - the price of being able to migrate
# without a second image.
#
# NOTE this is why `npm ci --omit=dev` is NOT used anywhere in this file:
# prisma, dotenv and tsx are all devDependencies, and all three are needed to
# run a migration. Trimming them would save disk and cost the ability to
# release.
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma/config ./node_modules/@prisma/config
COPY --from=builder --chown=node:node /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY --from=builder --chown=node:node /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=builder --chown=node:node /app/node_modules/tsx ./node_modules/tsx
# nodemailer drives scripts/check-attendance-alert.ts. Pure JavaScript with zero
# runtime dependencies (verified by npm ls at install time, Task 7), so the one
# package directory is the whole requirement. @types/nodemailer is build-time
# only and intentionally NOT copied: tsx erases types without loading it.
COPY --from=builder --chown=node:node /app/node_modules/nodemailer ./node_modules/nodemailer

# The backup script and the top-level better-sqlite3 it imports.
#
# This copy is REQUIRED and easy to get wrong. Verified on the host: standalone
# output contains node_modules/better-sqlite3 with ONLY a package.json - no
# lib/, no prebuilds/ - because the traced addon is the nested v12 under the
# adapter. Running backup-db.mjs from inside .next/standalone therefore fails
# with ERR_MODULE_NOT_FOUND on better-sqlite3/lib/index.js. Reproduced, not
# assumed.
#
# Copying the full package over the stub restores lib/ and prebuilds/. Verified
# on the host that a directory containing only backup-db.mjs plus
# better-sqlite3's package.json, lib/ and ONE prebuild (1.93 MB total) runs the
# backup successfully - all seven table counts matched and integrity_check
# returned ok.
#
# The whole package is copied rather than a single prebuild because pruning to
# one platform would silently break an arm64 deployment, and 16 MB of
# prebuilds is not worth that fragility.
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# All host-run scripts, not just backup-db.mjs. fetch-attendance.ts and
# check-attendance-alert.ts are TypeScript executed with tsx, which needs
# tsconfig.json at /app (the "@/*" path alias maps to ./src/*) plus the src/lib
# and src/generated trees the alert chain imports. The backup script keeps
# working: it lives in the copied scripts/ directory and its relative data path
# is unchanged. What the alert chain actually resolves at runtime is verified
# against the built image in the image-test task; missing packages get added
# there only if the run proves them missing - no speculative COPYs here.
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/src/lib ./src/lib
COPY --from=builder --chown=node:node /app/src/generated ./src/generated

# Mount points, created as root and handed to uid 1000. Both are expected to be
# bind-mounted or volume-backed at runtime; creating them here means a
# misconfigured compose file yields an empty directory rather than a
# permission error at startup.
#
# Note that a bind mount REPLACES this directory and carries the host's
# ownership, so these chowns only cover the un-mounted case. Getting host-side
# ownership right is a deploy step, not a build step - docs/DEPLOY.md covers it.
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups

# Everything below runs unprivileged.
USER node

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# HEALTHCHECK deliberately omitted.
#
# A naive `curl /` check would be actively harmful here: the root page returns
# HTTP 200 while serving DEMO DATA when the database is unreachable, because
# org-source.ts degrades rather than erroring. A green healthcheck would
# certify a broken deployment. A real check has to assert on page content (the
# absence of the 「演示数据」 marker), which belongs in a monitoring script with
# an owner, not in an image directive. docs/DEPLOY.md gives the manual check.

CMD ["node", "server.js"]
