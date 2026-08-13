// Organisation repository: departments (部) and sections (課).
//
// Ordering invariant, enforced by EVERY read here: ORDER BY sortOrder ASC, name ASC.
// `sortOrder` is not unique - it mirrors Excel row order and duplicates are expected
// after a re-import. Sorting on it alone leaves ties resolved by whatever the storage
// engine returns, which can differ between two queries over identical data. The
// dashboard addresses departments and sections by ARRAY INDEX, so a drifting
// tie-break silently drills into the wrong node. `name` is unique per level, so
// (sortOrder, name) is a total order.
//
// Write inputs are forwarded to Prisma verbatim to preserve the `undefined` = leave
// the stored value alone / `null` = clear the column distinction. Coercing with
// `?? null` would let a partial spreadsheet wipe manager data.

import type { Department, Section } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { writeMasterDataWithAudit } from "./master-data-change-log.repo";
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
 */
export async function upsertDepartment(input: DepartmentUpsertInput): Promise<DepartmentDto> {
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
    (w) => ({ action: w.created ? "create" : "update", targetKey: w.dto.name }),
  );
  return written.dto;
}

/**
 * Upserts a section keyed on the composite natural key (departmentId, name).
 * Section names are only unique within their department, hence the compound
 * `@@unique([departmentId, name])` key rather than `name` alone.
 *
 * Audited per D-173 - see {@link upsertDepartment} for why the pre-read is here.
 */
export async function upsertSection(input: SectionUpsertInput): Promise<SectionDto> {
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
    (w) => ({ action: w.created ? "create" : "update", targetKey: w.dto.name }),
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
export async function updateDepartment(id: string, patch: DepartmentPatch): Promise<DepartmentDto> {
  return writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const row = await tx.department.update({ where: { id }, data: departmentData(patch) });
      return toDepartmentDto(row);
    },
    (dto) => ({ action: "update", targetKey: dto.name }),
  );
}

/**
 * Patches a section by id. `departmentId` and `name` are not patchable: they form
 * the natural key, so a move or rename goes through {@link upsertSection}.
 *
 * Audited per D-173.
 *
 * @throws if no section has this id (Prisma P2025) - the transaction rolls back and
 *   no snapshot is written.
 */
export async function updateSection(id: string, patch: SectionPatch): Promise<SectionDto> {
  return writeMasterDataWithAudit(
    "organization",
    async (tx) => {
      const row = await tx.section.update({ where: { id }, data: sectionData(patch) });
      return toSectionDto(row);
    },
    (dto) => ({ action: "update", targetKey: dto.name }),
  );
}
