// Config repository: the `config` key-value table (e.g. daily_standard_hours = 8).
//
// Values are stored as String because SQLite has no typed key-value column and the
// table deliberately mixes numbers, flags and free text. Typing happens at the read
// site, which is why getConfigNumber() exists as a separate, forgiving accessor.

import { prisma } from "@/lib/prisma";

/** One config value by key, or null when the key is absent. */
export async function getConfig(key: string): Promise<string | null> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? null;
}

/**
 * Numeric config accessor that never throws.
 *
 * Returns `fallback` when the key is missing, the value is blank, or the value does
 * not parse to a finite number. Rationale: every caller of this function reads a
 * setting that HAS a sensible default (daily_standard_hours, prorate thresholds...),
 * so a missing or fat-fingered row must not take a dashboard page down. It is a
 * configuration problem, not a request problem.
 *
 * The trade-off is that a bad value would otherwise be invisible, so each fallback
 * is logged once via console.warn - silent defaulting is how a typo survives for
 * months. Finiteness is checked with Number.isFinite so that NaN, Infinity and
 * -Infinity are all rejected (`Number("")` is 0, hence the explicit blank check).
 */
export async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const raw = await getConfig(key);
  if (raw === null || raw.trim() === "") {
    console.warn(
      `[config] key "${key}" is missing or blank; falling back to ${fallback}`,
    );
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[config] key "${key}" holds a non-numeric value "${raw}"; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Every config entry as a plain key -> value map.
 * Handy for admin screens and for reading several settings without N round-trips.
 */
export async function getAllConfig(): Promise<Record<string, string>> {
  const rows = await prisma.config.findMany({ orderBy: { key: "asc" } });
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Creates or updates one config entry.
 *
 * `description` distinguishes undefined from null on purpose:
 *   * undefined -> the field is omitted from the update payload, so an existing
 *     description is PRESERVED. Callers that only want to change a value must not
 *     have to re-supply the documentation string, and `?? null` here would wipe it.
 *   * null      -> an explicit request to clear the description.
 * On create there is nothing to preserve, so undefined collapses to null.
 */
export async function setConfig(
  key: string,
  value: string,
  description?: string,
): Promise<void> {
  await prisma.config.upsert({
    where: { key },
    create: { key, value, description: description ?? null },
    update: { value, description },
  });
}

/**
 * Creates or updates many config entries in one transaction, returning the number
 * of rows written.
 *
 * An upsert loop rather than createMany: SQLite does not support
 * `createMany({ skipDuplicates })`, and seeding/re-importing config has to be
 * idempotent. Wrapping the loop in a single transaction keeps a partially applied
 * batch from being observable.
 */
export async function setConfigBulk(
  entries: readonly { key: string; value: string; description?: string }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let written = 0;
    for (const entry of entries) {
      await tx.config.upsert({
        where: { key: entry.key },
        create: {
          key: entry.key,
          value: entry.value,
          description: entry.description ?? null,
        },
        // See setConfig(): undefined preserves the stored description.
        update: { value: entry.value, description: entry.description },
      });
      written += 1;
    }
    return written;
  });
}
