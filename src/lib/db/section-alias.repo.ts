// Section-alias repository: maps an HR-export (部别, 课别) pair onto a Section.
//
// Why this table exists at all: the attendance export and the org master disagree on
// the spelling of at least one section. 检查课 (查 = U+67E5) and 检査课 (査 = U+67FB)
// render identically in most fonts and are never string-equal, so an exact-match join
// silently drops 25 rows a day - the section shows zero actuals while its hours
// accumulate in the unattributed bucket. Neither spelling is wrong, so this is a
// translation table, not a correction to either master.
//
// The alias keys are stored and compared VERBATIM. No trimming, no Unicode
// normalisation, no width folding: NFKC would happily fold some of the pairs this table
// exists to distinguish, which would turn a visible mismatch into an invisible one.

import { prisma } from "@/lib/prisma";
import { aliasKey } from "./section-key";
import type { SectionAliasDto, SectionAliasUpsertInput } from "./types";

export { aliasKey };

/** Prisma row -> DTO, dropping ORM-only fields such as `createdAt`. */
function toSectionAliasDto(row: {
  id: string;
  hrDeptName: string;
  hrSectionName: string;
  sectionId: string;
  remark: string | null;
}): SectionAliasDto {
  const { id, hrDeptName, hrSectionName, sectionId, remark } = row;
  return { id, hrDeptName, hrSectionName, sectionId, remark };
}

/**
 * Composite lookup key for the in-memory resolver.
 *
 * Re-exported from ./section-key so callers that already depend on this repository do not
 * need a second import; the definition itself lives in a prisma-free module because the
 * pure calculation layer builds the same keys.
 */

/** Every alias, ordered by (部, 課) for stable display. */
export async function findAllSectionAliases(): Promise<SectionAliasDto[]> {
  const rows = await prisma.sectionAlias.findMany({
    orderBy: [{ hrDeptName: "asc" }, { hrSectionName: "asc" }],
  });
  return rows.map(toSectionAliasDto);
}

/**
 * Loads the aliases as a `(部|課) -> sectionId` map for row-by-row resolution.
 *
 * An import walks hundreds of rows and every one needs a section lookup, so the whole
 * table is read once into memory rather than queried per row. It is a handful of rows -
 * this is cheaper than the round trips, and it makes the resolver a pure function.
 */
export async function loadSectionAliasMap(): Promise<Map<string, string>> {
  const rows = await prisma.sectionAlias.findMany({
    select: { hrDeptName: true, hrSectionName: true, sectionId: true },
  });
  return new Map(rows.map((r) => [aliasKey(r.hrDeptName, r.hrSectionName), r.sectionId]));
}

/**
 * Creates or updates one alias, keyed on the HR-side pair.
 *
 * `sectionId` is written on update as well: re-pointing an alias at a different Section
 * after an org restructure has to be expressible, and it is the only field worth
 * changing on an existing row.
 */
export async function upsertSectionAlias(
  input: SectionAliasUpsertInput,
): Promise<SectionAliasDto> {
  const { hrDeptName, hrSectionName, sectionId, remark } = input;
  const row = await prisma.sectionAlias.upsert({
    where: { hrDeptName_hrSectionName: { hrDeptName, hrSectionName } },
    create: { hrDeptName, hrSectionName, sectionId, remark },
    update: { sectionId, remark },
  });
  return toSectionAliasDto(row);
}

/**
 * Creates or updates many aliases in one transaction, returning rows written.
 *
 * Single transaction for the same reason as the job-title rules: a half-applied alias
 * set produces aggregates that look plausible but attribute a section's hours to
 * nowhere.
 */
export async function upsertSectionAliasesBulk(
  inputs: readonly SectionAliasUpsertInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let written = 0;
    for (const input of inputs) {
      const { hrDeptName, hrSectionName, sectionId, remark } = input;
      await tx.sectionAlias.upsert({
        where: { hrDeptName_hrSectionName: { hrDeptName, hrSectionName } },
        create: { hrDeptName, hrSectionName, sectionId, remark },
        update: { sectionId, remark },
      });
      written += 1;
    }
    return written;
  });
}
