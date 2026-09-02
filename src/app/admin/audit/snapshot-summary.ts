// Turns a stored master-data snapshot into one line of prose (D-183).
//
// The audit page deliberately does NOT diff two snapshots. A diff is the feature an
// operator eventually wants, but it is also the feature that decides - silently, in
// code - which differences matter, and getting that wrong on an audit screen means
// showing "no change" for a change that happened. Until there is a reason to take that
// on, the page states the size and shape of what was captured and lets the operator
// expand the raw payload, which is always faithful.
//
// Nothing here throws. A row whose `snapshot` column will not parse is a real
// possibility (raw SQL, a future format change, a truncated write), and a page that
// returns 500 because one of forty rows is malformed hides the other thirty-nine.

/** What a snapshot's JSON is expected to hold, per entity class. */
interface SnapshotShape {
  departments?: unknown;
  sections?: unknown;
  rules?: unknown;
}

/** Shown in place of a summary when the payload cannot be read. */
const UNREADABLE = "（快照无法解析）";

function lengthOf(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * One-line summary of a snapshot payload, e.g. `部 7 · 课 24` or `职位规则 7 条`.
 *
 * @param raw - the `snapshot` column verbatim.
 * @returns a display string, never an empty one. Malformed input yields UNREADABLE
 *   rather than throwing - see the file header.
 */
export function summariseSnapshot(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return UNREADABLE;
  }

  const shape = parsed as SnapshotShape;
  const parts: string[] = [];

  const departments = lengthOf(shape.departments);
  if (departments !== null) {
    parts.push(`部 ${departments}`);
  }
  const sections = lengthOf(shape.sections);
  if (sections !== null) {
    parts.push(`课 ${sections}`);
  }
  const rules = lengthOf(shape.rules);
  if (rules !== null) {
    parts.push(`职位规则 ${rules} 条`);
  }

  // An object that parsed but holds none of the three known keys: the format changed,
  // or this is not a snapshot at all. Saying so beats rendering an empty cell.
  return parts.length === 0 ? UNREADABLE : parts.join(" · ");
}

/**
 * Re-indents a snapshot for the collapsible raw view.
 *
 * Stored compact to keep the column small; unreadable that way at 24 sections on one
 * line. Returns the input untouched when it will not parse, so the operator still sees
 * whatever is actually in the column - which is the point of offering a raw view.
 */
export function prettyPrintSnapshot(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
