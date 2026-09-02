// Dashboard data-source switch.
//
// Phase 3 flips the default to the database (ORG_DATA_SOURCE=db in .env). The
// fixed-seed mock remains as a fallback for machines where the seed has not run,
// and set ORG_DATA_SOURCE=mock to force it back for a pixel-identical Phase 1 demo.
//
// SERVER ONLY. Reads process.env and imports the repository layer; importing this
// from a client component would pull Prisma into the browser bundle.

import "server-only";

import type { OrgRoot } from "@/types/manhour";
import { Prisma } from "@/generated/prisma/client";
import { ORG_MOCK } from "@/lib/mock/org";
import { findManualBaselineMonthsByFiscalYear } from "@/lib/db/actual.repo";
import { loadOrgRoot } from "@/lib/db/adapter/load-org";
import { findCurrentFiscalYear } from "@/lib/db/fiscal-year.repo";
import { findLatestSuccessfulImportLog } from "@/lib/db/import-log.repo";
import {
  describeImportStaleness,
  type ImportStaleness,
} from "@/lib/attendance/import-staleness";

export type OrgDataSource = "mock" | "db";

export interface DashboardOrg {
  org: OrgRoot;
  /** Which source actually produced `org` - may differ from the flag after a fallback. */
  source: OrgDataSource;
  /**
   * Name of the current fiscal year, or null when none is reachable.
   *
   * Returned from here rather than read again by the page: this function already
   * has to resolve the fiscal year to load the tree, and a second unguarded read
   * in the page would bypass the fallback below and 500 the whole dashboard over
   * a header label. (It did exactly that - see the guard's own reasoning.)
   */
  fiscalYearName: string | null;
  /**
   * Fiscal-year start year (the calendar year containing its April), or null when
   * no year is reachable.
   *
   * Carried alongside the name because the dashboard needs it to build month
   * labels via `lib/db/date.ts#fiscalMonthLabel`. The name is a free-text column
   * ("FY2026" by convention but not by constraint), so parsing digits out of it
   * would be a guess; `year` is the typed column that actually means this (D-165).
   * Null forces the client onto the hard-coded FY2026 fallback labels, which is
   * correct only because a null year means we are already rendering the mock.
   */
  fiscalYearStartYear: number | null;
  /**
   * D-124 attendance-freshness verdict, or null when there is nothing to judge.
   *
   * Null on EVERY degraded path, deliberately. When the tree is the mock, the import
   * log is either unreachable or irrelevant, and 「从未成功导入过考勤数据」 on top of
   * demo numbers names the wrong problem: the operator's actual problem is that the
   * database is not set up, which `source` already reports. A banner is only worth
   * showing when the figures behind it are real.
   *
   * Computed here rather than in the page because this function owns the
   * degrade-vs-fail policy for every database read on the dashboard (D-158). A
   * sibling read in the page bypassed that policy once already and 500'd the whole
   * screen over a header label.
   */
  importStaleness: ImportStaleness | null;
  /**
   * Fiscal months (1 = April) whose actual figures were typed in by hand (D-198).
   *
   * The dashboard captions those months rather than presenting them as attendance
   * output: a manual row carries the whole month in its total with the 人员/加班 split
   * unavailable, so the chart's personnel and overtime series are an undercount there
   * while the total is right. Empty on every degraded path, for the same reason
   * `importStaleness` is null - a provenance note on demo numbers names the wrong
   * problem.
   *
   * Derived from the stored rows, never a literal list of the back-filled months: the
   * first 8月 import the same way would turn a hard-coded footnote into a false claim
   * that nothing would catch.
   */
  manualBaselineMonths: readonly number[];
}

/** Parses the flag, treating anything other than an explicit 'db' as 'mock'. */
function readFlag(): OrgDataSource {
  return process.env.ORG_DATA_SOURCE === "db" ? "db" : "mock";
}

/**
 * Prisma error code for "the table does not exist" - i.e. the schema was never
 * migrated into this database file.
 */
const TABLE_MISSING = "P2021";

/**
 * True when `error` means "the database is not reachable or not set up yet",
 * as opposed to "the data inside it is wrong".
 *
 * This distinction is the whole point of the guard, and it CANNOT be made by
 * checking for a custom error subclass: there are none in this codebase, so an
 * invariant violation in org-tree.ts and a missing dev.db are both plain
 * `Error`s. The two cases were therefore identified empirically:
 *
 *   - dev.db's directory does not exist -> better-sqlite3 throws a plain
 *     TypeError, NOT a PrismaClientInitializationError. Matched on message
 *     because the adapter gives us nothing else to key on.
 *   - dev.db exists but was never migrated -> PrismaClientKnownRequestError
 *     with code P2021 (table does not exist).
 *
 * Anything else - a fiscal-year mismatch, an out-of-range month, a non-finite
 * hour count - is a statement that the stored data is corrupt, and is NOT
 * absorbed here.
 */
function isInfrastructureError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === TABLE_MISSING
  ) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  // The better-sqlite3 adapter surfaces an unopenable path as a bare TypeError.
  return (
    error instanceof Error &&
    /cannot open database|unable to open database/i.test(error.message)
  );
}

/**
 * Resolves the org tree the dashboard should render.
 *
 * Degrades to the mock for the three *setup* states that are reachable on a
 * machine where the seed has not run yet - no current fiscal year, empty org
 * table, unreachable or unmigrated database. A demo that shows
 * stale-but-plausible numbers beats a blank page.
 *
 * It does NOT degrade when the database is reachable but its contents violate an
 * invariant. Those errors (see org-tree.ts) exist specifically to stop *silently
 * wrong numbers*, and swallowing them to render a plausible-looking mock would
 * defeat the guard it just tripped - the reader would have no way to tell the
 * demo data from a real report. Note also that mock and seed agree on
 * 财务课 April plan (both 1045), so a silent fallback is genuinely invisible.
 *
 * Callers must surface `source` when it disagrees with the flag, so a fallback
 * is never mistaken for live data.
 *
 * Also resolves the D-124 attendance-freshness verdict, for the single reason that this
 * function is the dashboard's ONE guarded database entry point - see `importStaleness`.
 */
export async function loadDashboardOrg(): Promise<DashboardOrg> {
  const flag = readFlag();
  if (flag === "mock") {
    return {
      org: ORG_MOCK,
      source: "mock",
      fiscalYearName: null,
      fiscalYearStartYear: null,
      importStaleness: null,
      manualBaselineMonths: [],
    };
  }

  try {
    const fiscalYear = await findCurrentFiscalYear();
    if (fiscalYear === null) {
      console.warn(
        "[org-source] ORG_DATA_SOURCE=db but no fiscal year is flagged isCurrent; falling back to ORG_MOCK. Run `npm run db:seed`.",
      );
      return {
        org: ORG_MOCK,
        source: "mock",
        fiscalYearName: null,
        fiscalYearStartYear: null,
        importStaleness: null,
        manualBaselineMonths: [],
      };
    }

    const org = await loadOrgRoot(fiscalYear.id);
    if (org.depts.length === 0) {
      console.warn(
        `[org-source] ORG_DATA_SOURCE=db and fiscal year ${fiscalYear.name} is current, but no departments exist; falling back to ORG_MOCK. Run \`npm run db:seed\`.`,
      );
      // Keep the name: the year row is real and readable, only the org is empty.
      // But NOT the start year - the tree below is the mock, whose months are
      // FY2026 fixtures, so labelling them with a real FY2027 would misdate
      // demo data.
      return {
        org: ORG_MOCK,
        source: "mock",
        fiscalYearName: fiscalYear.name,
        fiscalYearStartYear: null,
        importStaleness: null,
        manualBaselineMonths: [],
      };
    }

    // Read AFTER the tree, not in a Promise.all beside it. The banner is a caption on
    // the numbers above it, so it is only meaningful once those numbers are known to be
    // real - and a parallel read would have to be guarded separately anyway, which is
    // the exact mistake D-158 records. Sequencing costs one round trip against a local
    // file and buys the guarantee that no unguarded promise is left in flight.
    const latestSuccess = await findLatestSuccessfulImportLog();
    // Same sequencing rule as the line above, and the same reason: this is a caption on
    // the numbers already loaded, and an unguarded promise in flight beside them is the
    // exact mistake D-158 records.
    const manualBaselineMonths = await findManualBaselineMonthsByFiscalYear(fiscalYear.id);

    return {
      org,
      source: "db",
      manualBaselineMonths,
      fiscalYearName: fiscalYear.name,
      fiscalYearStartYear: fiscalYear.year,
      importStaleness: describeImportStaleness(
        latestSuccess?.importedAt ?? null,
        new Date(),
      ),
    };
  } catch (error) {
    if (!isInfrastructureError(error)) {
      // Corrupt data, not a missing database. Let it reach the error boundary:
      // a loud failure is recoverable, a plausible wrong number is not.
      throw error;
    }
    console.error(
      "[org-source] Database is unreachable or unmigrated; falling back to ORG_MOCK. Run `npm run db:seed`.",
      error,
    );
    return {
      org: ORG_MOCK,
      source: "mock",
      fiscalYearName: null,
      fiscalYearStartYear: null,
      importStaleness: null,
      manualBaselineMonths: [],
    };
  }
}
