// Job-title rule repository (D-109): per-job-title exclusion flags applied when
// attendance rows are aggregated into `actual`.
//
// `jobTitle` is the primary key (@id) - the title string as it appears in the
// attendance export is the natural key, so every lookup and upsert addresses rows by
// `{ jobTitle }` and re-importing the rule sheet is inherently idempotent.
//
// Unlike WorkCalendarUpsertInput, the write input here is the full JobTitleRuleDto:
// `remark` is `string | null`, never undefined, so a re-import always states the
// complete intended state of a rule and there is no "preserve the old value" case to
// reason about. That is deliberate - an exclusion flag left at a stale value would
// silently distort personnel/overtime totals.

import type { JobTitleRule } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { JobTitleRuleDto } from "./types";

/** Maps a Prisma row to the DTO, dropping ORM-only fields such as `updatedAt`. */
function toJobTitleRuleDto(row: JobTitleRule): JobTitleRuleDto {
  return {
    jobTitle: row.jobTitle,
    excludePersonnelHours: row.excludePersonnelHours,
    excludeOvertimeHours: row.excludeOvertimeHours,
    remark: row.remark,
  };
}

/**
 * Every job-title rule, ordered by job title.
 *
 * Ordering is on the primary key, which is unique, so the result is a total order and
 * stable across queries - admin screens can address rows by index without drift.
 */
export async function findAllJobTitleRules(): Promise<JobTitleRuleDto[]> {
  const rows = await prisma.jobTitleRule.findMany({ orderBy: { jobTitle: "asc" } });
  return rows.map(toJobTitleRuleDto);
}

/**
 * One rule by job title, or null when no rule is registered.
 *
 * A null result means "no exclusions apply", which callers must treat as
 * both flags false rather than as an error: only titles that need excluding are
 * seeded, so the vast majority of titles have no row.
 */
export async function findJobTitleRule(
  jobTitle: string,
): Promise<JobTitleRuleDto | null> {
  const row = await prisma.jobTitleRule.findUnique({ where: { jobTitle } });
  return row === null ? null : toJobTitleRuleDto(row);
}

/**
 * Creates or updates one rule, keyed on `jobTitle` (the @id column).
 *
 * Both boolean flags and `remark` are written unconditionally: the DTO carries the
 * complete desired state, so an omitted-means-keep semantic would make it impossible
 * to turn an exclusion back off.
 */
export async function upsertJobTitleRule(input: JobTitleRuleDto): Promise<void> {
  await prisma.jobTitleRule.upsert({
    where: { jobTitle: input.jobTitle },
    create: {
      jobTitle: input.jobTitle,
      excludePersonnelHours: input.excludePersonnelHours,
      excludeOvertimeHours: input.excludeOvertimeHours,
      remark: input.remark,
    },
    update: {
      excludePersonnelHours: input.excludePersonnelHours,
      excludeOvertimeHours: input.excludeOvertimeHours,
      remark: input.remark,
    },
  });
}

/**
 * Inserts one rule, FAILING if `jobTitle` is already registered.
 *
 * Exists alongside {@link upsertJobTitleRule} because the two callers want opposite
 * things from a collision. The import path is idempotent by design - the rule sheet is
 * re-uploaded wholesale, so an existing title must be overwritten. The admin page's
 * "add rule" row is the opposite: `jobTitle` is the @id, so an upsert there would
 * silently replace the flags of a row already on screen the moment the administrator
 * mistypes an existing title. This raises Prisma P2002 instead, which the Server
 * Action turns into a field-level message.
 *
 * @throws PrismaClientKnownRequestError P2002 when the title already has a rule.
 */
export async function createJobTitleRule(input: JobTitleRuleDto): Promise<void> {
  await prisma.jobTitleRule.create({
    data: {
      jobTitle: input.jobTitle,
      excludePersonnelHours: input.excludePersonnelHours,
      excludeOvertimeHours: input.excludeOvertimeHours,
      remark: input.remark,
    },
  });
}

/**
 * Creates or updates many rules in one transaction, returning the number of rows
 * written.
 *
 * An upsert loop rather than createMany: SQLite does not support
 * `createMany({ skipDuplicates })`, and the rule sheet is re-uploaded wholesale, so
 * the operation has to be idempotent. The single transaction matters more here than
 * elsewhere - a half-applied exclusion set would produce plausible-looking but wrong
 * aggregates if an import failed midway.
 */
export async function upsertJobTitleRulesBulk(
  inputs: readonly JobTitleRuleDto[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let written = 0;
    for (const input of inputs) {
      await tx.jobTitleRule.upsert({
        where: { jobTitle: input.jobTitle },
        create: {
          jobTitle: input.jobTitle,
          excludePersonnelHours: input.excludePersonnelHours,
          excludeOvertimeHours: input.excludeOvertimeHours,
          remark: input.remark,
        },
        update: {
          excludePersonnelHours: input.excludePersonnelHours,
          excludeOvertimeHours: input.excludeOvertimeHours,
          remark: input.remark,
        },
      });
      written += 1;
    }
    return written;
  });
}
