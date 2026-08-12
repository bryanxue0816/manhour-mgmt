/**
 * Home (dashboard) page - server shell.
 *
 * A Server Component whose only job is to resolve the data source and hand a
 * ready-made org tree to the client shell. All interactivity (drill-down state,
 * memoized derivations, Recharts) lives in DashboardClient.
 *
 * Phase 3 reads live data (ORG_DATA_SOURCE=db); set the flag to "mock" for a
 * pixel-identical Phase 1 demo. Every database access goes through
 * loadDashboardOrg(), which owns the degrade-vs-fail policy - do not add a second
 * repository call to this file, or a setup failure will bypass that policy.
 *
 * `force-dynamic` is required now that the header label comes from the database:
 * without it Next would prerender this route at build time and open a connection
 * on a machine that has no dev.db, exactly as /admin and /plans document.
 */
import type { ReactElement } from "react";

import { loadDashboardOrg } from "@/lib/org-source";
import { MainNav } from "@/components/layout/MainNav";
import { DashboardClient } from "./_components/DashboardClient";
import { ImportStalenessBanner } from "./_components/ImportStalenessBanner";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<ReactElement> {
  // One call, not two. loadDashboardOrg() already resolves the fiscal year in
  // order to load the tree, and it applies the infrastructure-vs-corrupt-data
  // policy to that read. Calling findCurrentFiscalYear() again here in parallel
  // bypassed the policy: on a machine with no dev.db the tree degraded to mock
  // exactly as designed, then the unguarded sibling read rejected and 500'd the
  // whole dashboard over a header label. Verified by pointing DATABASE_URL at a
  // nonexistent directory.
  const { org, source, fiscalYearName, fiscalYearStartYear, importStaleness } =
    await loadDashboardOrg();

  // A fallback must never look like live data. Mock and seed agree on 财务课
  // April plan (both 1045), so without this marker a degraded page is
  // indistinguishable from a real report - someone would read demo numbers as
  // an actual account. `source` is what loadDashboardOrg() actually produced,
  // which may differ from the ORG_DATA_SOURCE flag it was asked for.
  const isFallback = process.env.ORG_DATA_SOURCE === "db" && source === "mock";

  return (
    <DashboardClient
      org={org}
      nav={<MainNav active="dashboard" />}
      // D-124's red banner. The verdict rides along in loadDashboardOrg()'s return value
      // rather than being read here, so it inherits that function's degrade-vs-fail
      // policy - which is also why it is null whenever the tree degraded to the mock:
      // 「从未成功导入」 stamped on demo numbers would name the wrong problem, and the
      // 「· 演示数据」 label already names the right one.
      banner={<ImportStalenessBanner staleness={importStaleness} />}
      // Null when the tree is the mock: its months are FY2026 fixtures, so the
      // client falls back to the hard-coded FY2026 labels rather than dating demo
      // data with a real year (D-165).
      fiscalYearStartYear={fiscalYearStartYear}
      // "未设置财年" rather than a fabricated year: an unflagged database is a
      // real state (D-008 leaves the flag to the admin), and showing a plausible
      // "FY2026" would hide it.
      fiscalYearLabel={
        (fiscalYearName ?? "未设置财年") + (isFallback ? " · 演示数据" : "")
      }
    />
  );
}
