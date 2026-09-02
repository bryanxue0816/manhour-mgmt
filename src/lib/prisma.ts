import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/**
 * Prisma client singleton.
 * Prisma 7 requires an explicit driver adapter (no implicit datasource-url connection).
 * Phase 0-1 dev: better-sqlite3 (SQLite). Phase 2: swap for @prisma/adapter-pg (PostgreSQL).
 * Prevents Next.js dev hot-reload from spawning multiple PrismaClient instances.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  // Fail fast with a message that names the cause. The adapter's own failure mode is
  // `TypeError: Cannot read properties of undefined (reading 'replace')` from deep
  // inside its dist bundle, which says nothing about a missing variable - and `.env`
  // is gitignored, so a fresh clone hits this every time. The `url` field types as
  // `string | (string & {})` rather than rejecting undefined (better-sqlite3 ships no
  // types, so the adapter's Options widen to any), meaning tsc will not catch it.
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and set it; " +
        "for the standalone build it must be an ABSOLUTE path (see D-188).",
    );
  }
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
