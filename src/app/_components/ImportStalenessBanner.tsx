/**
 * D-124's 看板首页红色 banner: attendance data has stopped arriving.
 *
 * A Server Component. It renders inside DashboardClient's client tree via the `banner`
 * prop, which keeps import-staleness.ts and the ImportStaleness type off the browser
 * bundle - the same arrangement MainNav uses.
 *
 * RED, but `destructive` red rather than `--actual`. D-124 asks for a red banner and this
 * is the token that means "something is wrong" across the rest of the app (see the import
 * form's FAILED tag). `--actual` is the 实绩工时 series colour, and the chart legend two
 * rows below this banner spends it on exactly that meaning; borrowing it here would make
 * the same red say "实绩" in one place and "故障" in another on a single screen.
 *
 * Louder than /actuals's warn-coloured row on purpose. There the operator is already
 * looking at the import panel and the history table is right below; here the banner is
 * interrupting someone who came to read totals and has no other reason to suspect the
 * numbers are short a few days.
 */
import type { ReactElement } from "react";

import type { ImportStaleness } from "@/lib/attendance/import-staleness";

export function ImportStalenessBanner({
  staleness,
}: {
  staleness: ImportStaleness | null;
}): ReactElement | null {
  // Null staleness (mock/degraded data) and level "ok" both render nothing. The absent
  // banner is the healthy state, so there is no "数据是新的" reassurance line: a banner
  // that is always present is a banner nobody reads.
  if (staleness === null || staleness.message === null) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/10 px-4 py-3 ring-1 ring-destructive/40"
    >
      <div className="flex items-start gap-2.5">
        {/* Paired with the text below, never carrying meaning alone - the icon is
            decorative and the sentence is the signal. */}
        <span aria-hidden="true" className="mt-0.5 size-2 shrink-0 rounded-full bg-destructive" />
        <p className="text-sm text-foreground">
          <span className="font-medium">考勤数据可能已过期：</span>
          {staleness.message}
        </p>
      </div>
      <a
        href="/actuals/import"
        className="inline-flex shrink-0 items-center rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-destructive/90"
      >
        导入考勤数据 →
      </a>
    </div>
  );
}
