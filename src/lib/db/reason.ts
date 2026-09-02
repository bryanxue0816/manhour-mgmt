// The one definition of what a free-text "why" means across both audit trails.
//
// Two tables carry a `reason`: `plan_change_log` (D-143, made mandatory by the UI in
// D-214) and `master_data_change_log` (D-184, optional). The two differ on whether a
// reason is REQUIRED - that is a UI-level policy and lives in the actions - but they
// must not differ on what a reason IS. Before this module existed the normaliser was a
// private copy in plan-change-log.repo, and adding a second copy for master data would
// have set up the usual drift: one side collapses "   " to null, the other stores it,
// and `reason IS NOT NULL` silently stops meaning "came with an explanation".

/**
 * Guards free-text reasons against an unbounded write.
 *
 * Both trails store `reason` in a plain String column with no database-level length
 * limit, so the cap has to be enforced before the write. 200 characters is enough for
 * a sentence explaining an edit and far short of anything that would bloat a row.
 */
export const REASON_MAX_LENGTH = 200;

/**
 * Collapses a blank reason to null.
 *
 * "" and "   " mean the same thing as omitting it. Storing the empty string instead
 * would make `reason IS NOT NULL` a useless filter for "changes that came with an
 * explanation" - the query would return every row and the trail would look fully
 * annotated while carrying no information.
 */
export function normaliseReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) {
    return null;
  }
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}
