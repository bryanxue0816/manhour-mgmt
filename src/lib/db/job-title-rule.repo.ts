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
import {
  ensureMasterDataBaseline,
  MASTER_DATA_ALL_TARGETS,
  recordMasterDataSnapshot,
  writeMasterDataWithAudit,
} from "./master-data-change-log.repo";
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
 *
 * Audited per D-173: an exclusion flag decides whether a job title's hours land in
 * the personnel/overtime totals, so "when did this rule start looking like this" is
 * exactly the question a disputed aggregate raises. The pre-read distinguishes
 * `create` from `update`, which Prisma's upsert does not report.
 *
 * @param reason - optional free-text why (D-184), a separate argument rather than a
 *   field on `input`: `input` is a {@link JobTitleRuleDto} that maps one-to-one onto
 *   columns of `job_title_rule`, and folding audit metadata into it is how a reason
 *   eventually gets written into the business row by accident.
 */
export async function upsertJobTitleRule(
  input: JobTitleRuleDto,
  reason?: string | null,
): Promise<void> {
  await writeMasterDataWithAudit(
    "job_title_rule",
    async (tx) => {
      const existing = await tx.jobTitleRule.findUnique({
        where: { jobTitle: input.jobTitle },
        select: { jobTitle: true },
      });
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
      return existing === null;
    },
    (created) => ({
      action: created ? "create" : "update",
      targetKey: input.jobTitle,
      reason,
    }),
  );
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
 * Audited per D-173. A P2002 collision rolls the transaction back, so a rejected
 * duplicate leaves no snapshot behind.
 *
 * @param reason - optional free-text why (D-184). A P2002 rollback discards it along
 *   with the snapshot row, so a rejected duplicate leaves no orphaned explanation.
 * @throws PrismaClientKnownRequestError P2002 when the title already has a rule.
 */
export async function createJobTitleRule(
  input: JobTitleRuleDto,
  reason?: string | null,
): Promise<void> {
  await writeMasterDataWithAudit(
    "job_title_rule",
    async (tx) => {
      await tx.jobTitleRule.create({
        data: {
          jobTitle: input.jobTitle,
          excludePersonnelHours: input.excludePersonnelHours,
          excludeOvertimeHours: input.excludeOvertimeHours,
          remark: input.remark,
        },
      });
    },
    () => ({ action: "create", targetKey: input.jobTitle, reason }),
  );
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
 *
 * Audited per D-173 with ONE snapshot for the whole batch, keyed
 * {@link MASTER_DATA_ALL_TARGETS}, not one per rule: the snapshot already contains
 * every rule, so per-row rows would repeat the identical payload N times while
 * describing a single operation. Because this function owns its transaction it calls
 * the audit functions directly rather than through writeMasterDataWithAudit.
 *
 * Takes no `reason` (D-184), unlike {@link upsertJobTitleRule}: the only caller is the
 * seed, which replays a fixed rule set with no operator behind it. A wholesale batch
 * has no per-rule explanation to record, so this snapshot's reason is always null.
 */
export async function upsertJobTitleRulesBulk(
  inputs: readonly JobTitleRuleDto[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    await ensureMasterDataBaseline(tx, "job_title_rule");
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
    await recordMasterDataSnapshot(tx, {
      entity: "job_title_rule",
      action: "update",
      targetKey: MASTER_DATA_ALL_TARGETS,
    });
    return written;
  });
}
