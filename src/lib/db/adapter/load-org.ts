// Async IO wrapper around the pure buildOrgRoot() transform.
//
// Kept separate from org-tree.ts on purpose: that file is a dependency-free pure
// function that can be unit-tested without a database, and mixing repository
// calls into it would drag Prisma into every test.
//
// Three reads, one batch. The dashboard renders a single consistent view of a
// fiscal year, so a re-import landing between two independent queries could pair
// this month's plans with last import's org tree.

import type { OrgRoot } from "@/types/manhour";

import { findActualsByFiscalYear } from "../actual.repo";
import { loadOrgSnapshot } from "../org.repo";
import { findPlansByFiscalYear } from "../plan.repo";
import { buildOrgRoot } from "./org-tree";

/**
 * Loads one fiscal year's org tree, ready for the dashboard.
 *
 * Sections with no plan or actual rows still appear, carrying twelve zeroed
 * months - see the invariants documented in org-tree.ts.
 *
 * @param fiscalYearId - Primary key of the fiscal year to load.
 * @param rootName - Label for the company-level root node. Defaults to '全公司'.
 */
export async function loadOrgRoot(
  fiscalYearId: string,
  rootName?: string,
): Promise<OrgRoot> {
  // Promise.all rather than sequential awaits: the three queries are
  // independent, and loadOrgSnapshot() already batches its own two reads into a
  // transaction. Total payload for a full fiscal year is under 50KB.
  const [snapshot, plans, actuals] = await Promise.all([
    loadOrgSnapshot(),
    findPlansByFiscalYear(fiscalYearId),
    findActualsByFiscalYear(fiscalYearId),
  ]);

  return buildOrgRoot({ snapshot, plans, actuals, rootName });
}
