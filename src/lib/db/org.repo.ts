// Organisation repository: departments (部) and sections (課).
//
// Ordering invariant, enforced by EVERY read here: ORDER BY sortOrder ASC, name ASC.
// `sortOrder` is not unique - it mirrors Excel row order and duplicates are expected
// after a re-import. Sorting on it alone leaves ties resolved by whatever the storage
// engine returns, which can differ between two queries over identical data. The
// dashboard addresses departments and sections by ARRAY INDEX, so a drifting
// tie-break silently drills into the wrong node.
//
// (sortOrder, name) is a total order for Department only - `Department.name` is
// globally `@unique`. It is NOT one for Section: `Section` only has
// `@@unique([departmentId, name])`, so a 課 name is unique within its 部, not across
// the table. findAllSections() therefore returns a stable order only as long as no
// two departments hold an equally-named 課 at the same sortOrder - a collision that
// becomes likely once sortOrder means "position within the department" rather than
// "Excel row number". Callers that need a guaranteed order must sort with
// departmentId participating; buildOrgRoot() is safe because it re-buckets by
// department before indexing. Do not rely on raw findAllSections() indices.
//
// Write inputs are forwarded to Prisma verbatim to preserve the `undefined` = leave
// the stored value alone / `null` = clear the column distinction. Coercing with
// `?? null` would let a partial spreadsheet wipe manager data.

import type { Department, Section } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ensureMasterDataBaseline,
  recordMasterDataSnapshot,
  writeMasterDataWithAudit,
} from "./master-data-change-log.repo";
import { aliasKey } from "./section-key";
import type {
  DepartmentDto,
  DepartmentPatch,
  DepartmentUpsertInput,
  OrgSnapshot,
  SectionDto,
  SectionPatch,
  SectionUpsertInput,
} from "./types";

/** Shared ordering clause - see the invariant documented at the top of the file. */
const ORG_ORDER_BY = [{ sortOrder: "asc" }, { name: "asc" }] as const;

/** Prisma row -> DTO, dropping ORM-only fields such as `createdAt`. */
function toDepartmentDto(row: Department): DepartmentDto {
  const { id, name, code, sortOrder, managerName, managerEmail } = row;
  return { id, name, code, sortOrder, managerName, managerEmail };
}

/** Prisma row -> DTO, dropping ORM-only fields such as `createdAt`. */
function toSectionDto(row: Section): SectionDto {
  const { id, departmentId, name, sortOrder, managerName, managerEmail } = row;
  return { id, departmentId, name, sortOrder, managerName, managerEmail };
}

/**
 * Writable column subsets. Keys left `undefined` are omitted by Prisma, which is
 * exactly the "keep the stored value" half of the contract described above.
 */
function departmentData(patch: DepartmentPatch) {
  const { sortOrder, code, managerName, managerEmail } = patch;
  return { sortOrder, code, managerName, managerEmail };
}

function sectionData(patch: SectionPatch) {
  const { sortOrder, managerName, managerEmail } = patch;
  return { sortOrder, managerName, managerEmail };
}

/** All departments in stable (sortOrder, name) order. */
export async function findAllDepartments(): Promise<DepartmentDto[]> {
  const rows = await prisma.department.findMany({ orderBy: [...ORG_ORDER_BY] });
  return rows.map(toDepartmentDto);
}

/** One department by primary key, or null when absent. */
export async function findDepartmentById(id: string): Promise<DepartmentDto | null> {
  const row = await prisma.department.findUnique({ where: { id } });
  return row === null ? null : toDepartmentDto(row);
}

/** All sections across all departments, in stable (sortOrder, name) order. */
export async function findAllSections(): Promise<SectionDto[]> {
  const rows = await prisma.section.findMany({ orderBy: [...ORG_ORDER_BY] });
  return rows.map(toSectionDto);
}

/** Sections of one department, in stable (sortOrder, name) order. */
export async function findSectionsByDepartment(departmentId: string): Promise<SectionDto[]> {
  const rows = await prisma.section.findMany({
    where: { departmentId },
    orderBy: [...ORG_ORDER_BY],
  });
  return rows.map(toSectionDto);
}

/** One section by primary key, or null when absent. */
export async function findSectionById(id: string): Promise<SectionDto | null> {
  const row = await prisma.section.findUnique({ where: { id } });
  return row === null ? null : toSectionDto(row);
}

/**
 * One snapshot, both levels ordered by (sortOrder, name).
 *
 * Both reads share a single `$transaction` rather than two awaits: the org tree
 * joins sections onto departments by id, so a re-import landing between two
 * independent queries would yield sections whose parent is missing from the
 * department list. The batch guarantees one consistent read snapshot.
 */
export async function loadOrgSnapshot(): Promise<OrgSnapshot> {
  const [departments, sections] = await prisma.$transaction([
    prisma.department.findMany({ orderBy: [...ORG_ORDER_BY] }),
    prisma.section.findMany({ orderBy: [...ORG_ORDER_BY] }),
  ]);
  return {
    departments: departments.map(toDepartmentDto),
    sections: sections.map(toSectionDto),
  };
}

/**
 * Upserts a department keyed on `name`, NOT on id.
 *
 * Org changes arrive as a full Excel re-upload and history is never deleted
 * (D-153), so seed and every later re-import share this single write path.
 * `name` is `@unique`, which makes it the natural key.
 *
 * Audited per D-173: the write and its snapshot share one transaction, so a failed
 * snapshot rolls the write back rather than leaving the trail incomplete. The
 * pre-read is what lets the trail say `create` or `update` truthfully - Prisma's
 * upsert does not report which branch it took, and a re-import recorded as `create`
 * would misdescribe an overwrite.
 *
 * @param reason - optional free-text why (D-184), kept as a separate argument rather
 *   than a field on `input`: `input` maps one-to-one onto columns of `Department`, and
 *   folding audit metadata into it is how a reason eventually gets written into the
 *   business row by accident. Seed and Excel re-imports pass nothing, so their rows
 *   carry null - which is correct, a bulk re-upload has no per-row explanation.
 */
export async function upsertDepartment(
  input: DepartmentUpsertInput,
  reason?: string | null,
): Promise<DepartmentDto> {
  const written = await writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const existing = await tx.department.findUnique({
        where: { name: input.name },
        select: { id: true },
      });
      const row = await tx.department.upsert({
        where: { name: input.name },
        create: { ...departmentData(input), name: input.name, sortOrder: input.sortOrder },
        update: departmentData(input),
      });
      return { dto: toDepartmentDto(row), created: existing === null };
    },
    (w) => ({ action: w.created ? "create" : "update", targetKey: w.dto.name, reason }),
  );
  return written.dto;
}

/**
 * Upserts a section keyed on the composite natural key (departmentId, name).
 * Section names are only unique within their department, hence the compound
 * `@@unique([departmentId, name])` key rather than `name` alone.
 *
 * Audited per D-173 - see {@link upsertDepartment} for why the pre-read is here, and
 * for why `reason` is a separate argument.
 */
export async function upsertSection(
  input: SectionUpsertInput,
  reason?: string | null,
): Promise<SectionDto> {
  const { departmentId, name, sortOrder } = input;
  const written = await writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const existing = await tx.section.findUnique({
        where: { departmentId_name: { departmentId, name } },
        select: { id: true },
      });
      const row = await tx.section.upsert({
        where: { departmentId_name: { departmentId, name } },
        create: { ...sectionData(input), departmentId, name, sortOrder },
        update: sectionData(input),
      });
      return { dto: toSectionDto(row), created: existing === null };
    },
    (w) => ({ action: w.created ? "create" : "update", targetKey: w.dto.name, reason }),
  );
  return written.dto;
}

/**
 * Patches a department by id, keeping the undefined/null contract above.
 *
 * Audited per D-173. `targetKey` is the name from the row Prisma returns, not the
 * id: an audit read six months later needs a human-readable key.
 *
 * @throws if no department has this id (Prisma P2025) - the transaction rolls back
 *   and no snapshot is written, so the trail never claims a failed edit happened.
 */
export async function updateDepartment(
  id: string,
  patch: DepartmentPatch,
  reason?: string | null,
): Promise<DepartmentDto> {
  return writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const row = await tx.department.update({ where: { id }, data: departmentData(patch) });
      return toDepartmentDto(row);
    },
    (dto) => ({ action: "update", targetKey: dto.name, reason }),
  );
}

/**
 * Patches a section by id. `departmentId` and `name` are not patchable here: they
 * form the natural key, so a move goes through {@link upsertSection} and a rename
 * through {@link renameSectionWithAlias}, which has to write an alias alongside it.
 *
 * Audited per D-173.
 *
 * @throws if no section has this id (Prisma P2025) - the transaction rolls back and
 *   no snapshot is written.
 */
export async function updateSection(
  id: string,
  patch: SectionPatch,
  reason?: string | null,
): Promise<SectionDto> {
  return writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const row = await tx.section.update({ where: { id }, data: sectionData(patch) });
      return toSectionDto(row);
    },
    (dto) => ({ action: "update", targetKey: dto.name, reason }),
  );
}

/** Why a rename was refused. Each value maps to one message at the action layer. */
export type SectionRenameFailure =
  | "not-found"
  | "name-taken"
  | "alias-conflict"
  | "alias-shadow";

/**
 * A rename the repository refuses, as opposed to a bug.
 *
 * Thrown rather than returned so the happy path keeps the `Promise<SectionDto>` shape
 * of its siblings, and carries `reason` because the four refusals need four different
 * things from the operator - the message alone would force the caller to match on
 * text.
 */
export class SectionRenameError extends Error {
  readonly reason: SectionRenameFailure;

  constructor(reason: SectionRenameFailure, message: string) {
    super(message);
    this.name = "SectionRenameError";
    this.reason = reason;
  }
}

/**
 * Renames a section and leaves an alias behind so historical attendance keeps
 * resolving to it.
 *
 * Why this cannot be a plain `update`: resolveSectionId() in lib/attendance/calc.ts
 * looks a row up by `aliasKey(部名, 课名)` against an index built from the CURRENT
 * section names, falls back to the alias table, and returns `null` on a double miss.
 * `null` is a warning, never a rejection (D-164), so a bare rename would send every
 * historical HR row carrying the old spelling into the 未归属 bucket - silently, with
 * no error anywhere. The alias written here is what keeps them attached.
 *
 * All four writes - name, alias, baseline, snapshot - share one transaction. Half
 * success is the failure mode that matters: a committed rename without its alias
 * moves historical hours without saying so.
 *
 * Renaming back to a previous name is safe and needs no cleanup: the old alias then
 * points at the same section the live name resolves to, so both paths agree.
 *
 * @param newName - already trimmed and validated by the caller. Compared verbatim,
 *   like every other section key (see aliasKey's note on normalisation).
 * @param reason - optional free-text why (D-184). Ignored on the no-op path below,
 *   which writes no row for it to annotate.
 * @returns the section after the rename; unchanged, with nothing written, when
 *   `newName` already equals the stored name.
 * @throws {SectionRenameError} on any of the four refusals.
 */
export async function renameSectionWithAlias(
  id: string,
  newName: string,
  reason?: string | null,
): Promise<SectionDto> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.section.findUnique({
      where: { id },
      include: { department: { select: { name: true } } },
    });
    if (current === null) {
      throw new SectionRenameError("not-found", `No section has id ${JSON.stringify(id)}.`);
    }
    const oldName = current.name;
    const deptName = current.department.name;

    // Idempotent, and deliberately BEFORE the baseline: a no-op that still appended a
    // snapshot would put an edit in the trail that never happened.
    if (oldName === newName) {
      return toSectionDto(current);
    }

    // Checked here rather than left to the unique constraint so the caller gets a
    // reason instead of a P2002 it has to decode.
    const taken = await tx.section.findUnique({
      where: { departmentId_name: { departmentId: current.departmentId, name: newName } },
      select: { id: true },
    });
    if (taken !== null) {
      throw new SectionRenameError(
        "name-taken",
        `Department ${JSON.stringify(deptName)} already has a section named ` +
          `${JSON.stringify(newName)}.`,
      );
    }

    // An alias on the OLD spelling that points somewhere else is a deliberate human
    // mapping, and this rename would have to overwrite it to keep its own history.
    // Refusing is the lesser harm: re-pointing it moves another section's historical
    // hours with nothing on screen to say so.
    const aliasOnOldName = await tx.sectionAlias.findUnique({
      where: { hrDeptName_hrSectionName: { hrDeptName: deptName, hrSectionName: oldName } },
      select: { sectionId: true },
    });
    if (aliasOnOldName !== null && aliasOnOldName.sectionId !== id) {
      throw new SectionRenameError(
        "alias-conflict",
        `${JSON.stringify(aliasKey(deptName, oldName))} is already mapped to another ` +
          "section. Re-point or remove that alias first.",
      );
    }

    // The mirror image: resolveSectionId() consults the live name index BEFORE the
    // alias table, so taking a name that an alias already claims would make this
    // section shadow it and quietly absorb the other one's rows.
    const aliasOnNewName = await tx.sectionAlias.findUnique({
      where: { hrDeptName_hrSectionName: { hrDeptName: deptName, hrSectionName: newName } },
      select: { sectionId: true },
    });
    if (aliasOnNewName !== null && aliasOnNewName.sectionId !== id) {
      throw new SectionRenameError(
        "alias-shadow",
        `${JSON.stringify(aliasKey(deptName, newName))} is an alias of another section. ` +
          "Renaming to it would take that section's historical rows.",
      );
    }

    await ensureMasterDataBaseline(tx, "organization");
    const row = await tx.section.update({ where: { id }, data: { name: newName } });
    if (aliasOnOldName === null) {
      await tx.sectionAlias.create({
        data: {
          hrDeptName: deptName,
          hrSectionName: oldName,
          sectionId: id,
          remark: `Rename trail: "${oldName}" -> "${newName}".`,
        },
      });
    }
    await recordMasterDataSnapshot(tx, {
      entity: "organization",
      action: "update",
      targetKey: row.name,
      reason,
    });
    return toSectionDto(row);
  });
}
