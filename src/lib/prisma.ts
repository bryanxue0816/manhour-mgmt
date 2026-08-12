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
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
