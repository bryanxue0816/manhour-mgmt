/**
 * Pure grouping helpers backing the OrgEditor.
 *
 * Kept in its own module rather than inlined into the editor because the parent/child
 * and orphan rules are the part worth testing: they decide which sections appear under
 * which department, and a silent drift there would show a wrong parent on screen with
 * nothing saying which is right. No React and no server-only imports here, so a client
 * component can pull it in without dragging a server module into the browser bundle.
 */
import type { DepartmentDto, SectionDto } from "@/lib/db/types";

/** One department together with the sections that belong to it. */
export interface OrgGroup {
  readonly department: DepartmentDto;
  readonly sections: readonly SectionDto[];
}

/**
 * Buckets sections under their parent department, preserving the repository's
 * (sortOrder, name) ordering on both levels. Built with `map`/`filter` so no
 * intermediate array is ever mutated.
 */
export function groupByDepartment(
  departments: readonly DepartmentDto[],
  sections: readonly SectionDto[],
): readonly OrgGroup[] {
  return departments.map((department) => ({
    department,
    sections: sections.filter((section) => section.departmentId === department.id),
  }));
}

/**
 * Sections whose `departmentId` matches no department in the snapshot.
 * Empty for consistent data; surfaced rather than silently dropped so a broken
 * import is visible on the admin screen instead of invisible.
 */
export function findOrphanSections(
  departments: readonly DepartmentDto[],
  sections: readonly SectionDto[],
): readonly SectionDto[] {
  return sections.filter(
    (section) => !departments.some((department) => department.id === section.departmentId),
  );
}
