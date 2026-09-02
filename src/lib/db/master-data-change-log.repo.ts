// Snapshot audit trail for master data - organisation tree and job-title rules (D-173).
//
// This module is the only writer of `master_data_change_log`. Three constraints shape
// the API, and each one exists because of a way audit trails usually fail:
//
//   * Both writers REQUIRE a transaction client and there is no overload taking the
//     global `prisma`. D-173 says one snapshot per successful write; if the audit row
//     could fail while the business write committed, the table would be silently
//     incomplete - and an audit believed to be complete but is not is worse than no
//     audit at all. Same reasoning as appendPlanChangeLogs() in plan-change-log.repo.
//   * The snapshot is the state AFTER the write, and the state BEFORE the very first
//     write is preserved by a one-off `baseline` row. Hence two calls, not one:
//     ensureMasterDataBaseline() must run BEFORE the business write (it reads the
//     pre-write state) and recordMasterDataSnapshot() AFTER it. Auto-emitting the
//     baseline from inside the post-write call would snapshot the already-changed
//     state and lose the original permanently.
//   * There is no update and no delete. Corrections are further rows.
//
// Granularity is the whole entity class, not the edited field: 31 org rows serialise
// to roughly 4 KB and 7 rules to about 1 KB, so a few hundred edits a year cost about
// a megabyte and retention can be permanent with no capacity trade-off (D-173). The
// accepted cost is redundancy - renumbering 24 sections one at a time stores 24
// near-identical snapshots.

import type { MasterDataChangeLog, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { REASON_MAX_LENGTH, normaliseReason } from "./reason";

/** Entity classes that carry a snapshot trail. Matches the `entity` column. */
export const MASTER_DATA_ENTITIES = [
  "organization",
  "job_title_rule",
  "actual_baseline",
] as const;

export type MasterDataEntity = (typeof MASTER_DATA_ENTITIES)[number];

/**
 * Legal values of the `action` column.
 *
 * No `delete`: D-172 withdrew the delete-a-department/section requirement outright,
 * and all four inbound foreign keys are `onDelete: Restrict`, so no delete can occur
 * for this trail to record.
 */
export type MasterDataAction = "baseline" | "create" | "update";

const MASTER_DATA_ACTIONS: ReadonlySet<string> = new Set<MasterDataAction>([
  "baseline",
  "create",
  "update",
]);

const MASTER_DATA_ENTITY_SET: ReadonlySet<string> = new Set<MasterDataEntity>(
  MASTER_DATA_ENTITIES,
);

/**
 * `targetKey` for rows that describe the entity class as a whole rather than one
 * edited row - the initial baseline, and bulk re-imports that touch every rule.
 */
export const MASTER_DATA_ALL_TARGETS = "*";

/** Read shape. Declared here so the generated Prisma row type stays internal. */
export interface MasterDataChangeLogDto {
  id: string;
  entity: MasterDataEntity;
  action: MasterDataAction;
  targetKey: string;
  snapshot: string;
  /** Null whenever the operator did not type one, which is the normal case (D-184). */
  reason: string | null;
  changedAt: Date;
  changedBy: string;
}

export interface MasterDataSnapshotInput {
  entity: MasterDataEntity;
  action: MasterDataAction;
  /** Section name, department name, or jobTitle. See MASTER_DATA_ALL_TARGETS. */
  targetKey: string;
  /**
   * Optional free-text why (D-184). Blank collapses to null.
   *
   * Optional here on purpose, and it stays optional at every layer: an organisation
   * change is rare and its motive is usually evident from the snapshot, so making it
   * mandatory - as D-214 does for plan hours - would only collect the word "调整".
   */
  reason?: string | null;
}

/**
 * Maps a Prisma row to the DTO.
 *
 * `entity` and `action` are narrowed by assertion, not re-validated: every row was
 * written through this module, which rejects anything outside the sets above.
 * Re-checking on read would only catch rows inserted by raw SQL, and refusing to
 * read is the wrong response to that - the trail should stay readable.
 */
function toMasterDataChangeLogDto(row: MasterDataChangeLog): MasterDataChangeLogDto {
  return {
    id: row.id,
    entity: row.entity as MasterDataEntity,
    action: row.action as MasterDataAction,
    targetKey: row.targetKey,
    snapshot: row.snapshot,
    reason: row.reason,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
  };
}

/**
 * Serialises the current state of one entity class.
 *
 * Columns are listed explicitly rather than taking the whole row, for two reasons:
 * the field set becomes part of the stored format, so it must change only on purpose;
 * and `createdAt` / `updatedAt` are excluded because a timestamp that moves on every
 * write would make two snapshots of identical business state compare as different.
 *
 * Ordering is the same total order the rest of the org layer uses - (sortOrder, name)
 * for the tree, the primary key for rules - so a diff between two snapshots shows
 * real changes rather than row-order churn.
 *
 * Adding a business column to Department, Section, or JobTitleRule means adding it
 * here too; otherwise the trail keeps recording it as if it never existed.
 */
async function serialiseEntity(
  tx: Prisma.TransactionClient,
  entity: MasterDataEntity,
): Promise<string> {
  if (entity === "organization") {
    // Sequential, not Promise.all: `tx` is one connection inside an interactive
    // transaction, and both reads are already inside a single consistent snapshot,
    // so concurrency would buy nothing and only risk driver-level serialisation
    // surprises.
    const departments = await tx.department.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        sortOrder: true,
        managerName: true,
        managerEmail: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const sections = await tx.section.findMany({
      select: {
        id: true,
        departmentId: true,
        name: true,
        sortOrder: true,
        managerName: true,
        managerEmail: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return JSON.stringify({ departments, sections });
  }
  if (entity === "actual_baseline") {
    // Only manual rows. Fold rows are reproducible from attendance_raw at any time, so
    // snapshotting them would bloat the trail with data that is not at risk; a hand-typed
    // baseline has no other copy anywhere and is exactly what needs to be recoverable.
    const actuals = await tx.actual.findMany({
      where: { source: "manual" },
      select: {
        month: true,
        totalHours: true,
        source: true,
        section: { select: { name: true, department: { select: { name: true } } } },
      },
      orderBy: [{ month: "asc" }, { sectionId: "asc" }],
    });
    return JSON.stringify({
      actuals: actuals.map((a) => ({
        department: a.section.department.name,
        section: a.section.name,
        month: a.month,
        totalHours: a.totalHours,
        source: a.source,
      })),
    });
  }
  const rules = await tx.jobTitleRule.findMany({
    select: {
      jobTitle: true,
      excludePersonnelHours: true,
      excludeOvertimeHours: true,
      remark: true,
    },
    orderBy: { jobTitle: "asc" },
  });
  return JSON.stringify({ rules });
}

/** @throws if the entity, action, target key, or reason would widen a plain String column. */
function assertSnapshotInput(input: MasterDataSnapshotInput): void {
  if (!MASTER_DATA_ENTITY_SET.has(input.entity)) {
    throw new Error(
      `Invalid master data entity: ${JSON.stringify(input.entity)} ` +
        `(expected one of ${MASTER_DATA_ENTITIES.join(", ")}).`,
    );
  }
  if (!MASTER_DATA_ACTIONS.has(input.action)) {
    throw new Error(
      `Invalid master data action: ${JSON.stringify(input.action)} ` +
        "(expected 'baseline', 'create', or 'update').",
    );
  }
  if (input.targetKey.trim() === "") {
    throw new Error(
      "Invalid master data snapshot: targetKey is required. A snapshot that does " +
        "not say what was edited cannot be read back usefully (D-173).",
    );
  }
  // Length only. A blank reason is legal (D-184) and normaliseReason turns it into
  // null; there is nothing else to check, because the column is free text by design.
  if (input.reason !== undefined && input.reason !== null && input.reason.length > REASON_MAX_LENGTH) {
    throw new Error(
      `Invalid master data snapshot: reason exceeds ${REASON_MAX_LENGTH} characters.`,
    );
  }
}

/**
 * Appends one snapshot of the entity class as it stands NOW, inside a caller-owned
 * transaction.
 *
 * @param tx - transaction client from the SAME `$transaction` as the write being
 *   recorded. Passing the global `prisma` is a type error, and that is the point: a
 *   snapshot committed independently of the write it describes can survive a
 *   rollback, or be lost while the write commits.
 *
 * Call this AFTER the business write, so the snapshot reflects the new state.
 */
export async function recordMasterDataSnapshot(
  tx: Prisma.TransactionClient,
  input: MasterDataSnapshotInput,
): Promise<void> {
  assertSnapshotInput(input);
  const snapshot = await serialiseEntity(tx, input.entity);
  await tx.masterDataChangeLog.create({
    data: {
      entity: input.entity,
      action: input.action,
      targetKey: input.targetKey,
      snapshot,
      reason: normaliseReason(input.reason),
    },
  });
}

/**
 * Writes the `baseline` row for an entity class if the trail for it is still empty,
 * and reports whether it did.
 *
 * Call this BEFORE the business write. Since only post-write snapshots are stored,
 * without a baseline the state that preceded the first ever edit would be
 * unrecoverable. Doing it lazily on first write - rather than as a seed step or a
 * migration - means no extra operational step, and it self-heals on a database that
 * already had master data before this table existed.
 *
 * The emptiness check and the insert share the caller's transaction, so two
 * concurrent first writes cannot both decide the trail is empty.
 *
 * The baseline row never carries a reason: it describes the state before anybody
 * edited anything, so the operator's explanation for the edit that triggered it
 * belongs on that edit's own row, not here.
 */
export async function ensureMasterDataBaseline(
  tx: Prisma.TransactionClient,
  entity: MasterDataEntity,
): Promise<boolean> {
  if (!MASTER_DATA_ENTITY_SET.has(entity)) {
    throw new Error(
      `Invalid master data entity: ${JSON.stringify(entity)} ` +
        `(expected one of ${MASTER_DATA_ENTITIES.join(", ")}).`,
    );
  }
  const existing = await tx.masterDataChangeLog.count({ where: { entity } });
  if (existing > 0) {
    return false;
  }
  await recordMasterDataSnapshot(tx, {
    entity,
    action: "baseline",
    targetKey: MASTER_DATA_ALL_TARGETS,
  });
  return true;
}

/**
 * Runs one master-data write with its audit trail, in a single transaction.
 *
 * The composition point for repository writes that do not already own a transaction:
 * baseline (pre-write) -> write -> snapshot (post-write). A failure anywhere - the
 * write itself, or the audit - rolls back all of it, which is the guarantee D-173
 * depends on. Writers that already open a transaction (upsertJobTitleRulesBulk)
 * call the two audit functions directly instead.
 *
 * @param describe - derives the audit row from the write's own result. Both parts
 *   need the result: an update addressed by id does not know the human-readable key
 *   until the row comes back, and an upsert only knows whether it created or updated
 *   from what it observed. Taken as one callback so a caller cannot supply a
 *   `create` action alongside a key from an updated row. May also return the
 *   operator's optional `reason` (D-184); omitting it stores null.
 */
export async function writeMasterDataWithAudit<T>(
  entity: MasterDataEntity,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  describe: (written: T) => {
    action: MasterDataAction;
    targetKey: string;
    reason?: string | null;
  },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await ensureMasterDataBaseline(tx, entity);
    const written = await write(tx);
    const { action, targetKey, reason } = describe(written);
    await recordMasterDataSnapshot(tx, { entity, action, targetKey, reason });
    return written;
  });
}

/** Paging window for the audit page. Both fields optional; defaults are safe. */
export interface MasterDataChangeLogQuery {
  entity?: MasterDataEntity;
  /** Caps the result. Adjusting 24 sections one at a time writes 24 rows. */
  limit?: number;
  /** Rows to skip. Paired with countMasterDataChangeLogs() for page numbers. */
  offset?: number;
}

/**
 * Snapshots newest first, optionally for one entity class.
 *
 * Takes an options object rather than positional arguments because there are now three
 * independent knobs: a call that wants page 3 of everything would otherwise have to
 * pass `undefined` for the entity and repeat the default limit just to reach `offset`.
 *
 * Ordering is (changedAt desc, id desc). The timestamp alone is not a total order -
 * one operator action writes a baseline row and a snapshot row inside a single
 * transaction, and SQLite can stamp both with the same millisecond, which would let
 * the same row appear on two pages or on none.
 */
export async function findMasterDataChangeLogs(
  query: MasterDataChangeLogQuery = {},
): Promise<MasterDataChangeLogDto[]> {
  const rows = await prisma.masterDataChangeLog.findMany({
    where: query.entity === undefined ? undefined : { entity: query.entity },
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    take: query.limit ?? 50,
    skip: query.offset ?? 0,
  });
  return rows.map(toMasterDataChangeLogDto);
}

/** Row count, optionally for one entity class. Drives admin counters and tests. */
export async function countMasterDataChangeLogs(entity?: MasterDataEntity): Promise<number> {
  return prisma.masterDataChangeLog.count({
    where: entity === undefined ? undefined : { entity },
  });
}
