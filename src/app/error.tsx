"use client";

/**
 * Segment-level error boundary for every route under `app/`.
 *
 * This file is the other half of D-158. That decision deliberately refuses to
 * degrade to mock data when the failure looks like data corruption rather than an
 * infrastructure outage - it lets the error propagate instead of quietly rendering
 * plausible fixtures. Without a boundary, "propagate" ended at Next's built-in
 * fallback: an unstyled page with no way back and no fault identifier. The whole
 * point of throwing was that a human notices and can act on it.
 *
 * The copy is deliberate, for the same reason D-164 and D-165 argue about copy: the
 * dangerous failure mode in this app is a screen that looks calm while showing
 * nothing. So this page states outright that NO figures were rendered and that
 * anything remembered from a previous screen is stale - never "暂无数据", which reads
 * as "the month is empty" rather than "the read failed".
 *
 * A Client Component by contract (Next requires it) and by need: `reset()` is a
 * client callback. It re-renders the failed segment without a full reload, which is
 * the right first move for a transient fault - a locked SQLite file, a dev server
 * mid-restart - and costs nothing when the fault is permanent.
 */

import { useEffect } from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";

export interface ErrorPageProps {
  /**
   * The thrown error. In production Next replaces `message` with a generic string
   * and exposes `digest` instead, so the digest is the only thing that correlates
   * this screen with a server log line. It is therefore rendered, not hidden.
   */
  error: Error & { digest?: string };
  /** Re-renders the failed segment in place. */
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // The only sink available. Server-thrown errors are already on the server log;
    // an error thrown while rendering a client component (a bad fold in calc.ts, a
    // null node after a drill) is logged nowhere else, and a fault that leaves no
    // trace anywhere is indistinguishable from a user misreading the screen.
    console.error("[manhour] unhandled render error", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-destructive uppercase">
            Error
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">
            页面加载失败
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            本页没有渲染出任何工时数字。屏幕上残留的内容（如有）来自上一次成功的加载，已不可信。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <section
          aria-labelledby="error-detail-heading"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-5"
        >
          <h2
            id="error-detail-heading"
            className="text-xs font-semibold tracking-[0.14em] text-destructive uppercase"
          >
            故障信息
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">错误</dt>
              <dd className="min-w-0 font-mono text-xs break-words">
                {error.message === "" ? "（无消息）" : error.message}
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">追踪码</dt>
              <dd className="min-w-0 font-mono text-xs break-words">
                {/*
                  Present only for server-side errors. Its absence is itself
                  information - it means the fault happened in the browser, so the
                  server log will not contain it and there is nothing to look up.
                */}
                {error.digest ?? "（无 · 该错误发生在浏览器端，服务端日志中没有对应记录）"}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="error-next-heading">
          <h2
            id="error-next-heading"
            className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase"
          >
            接下来
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            先重试一次。若仍然失败，请把上面的追踪码连同操作步骤一并反馈，不要以本页残留的数字做任何判断。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={reset}>重试本页</Button>
            {/*
              Two deliberate choices here.

              Not `<MainNav>`: this is a client boundary, and MainNav is documented as
              a Server Component on purpose - importing it would pull it into the
              browser bundle. This page is also not one of the four screens, so
              `active` has no truthful value and aria-current would lie.

              `buttonVariants` on a plain <Link> rather than a wrapped <Button>: the
              local Button has no `asChild`, so nesting a Link inside it would render
              an <a> inside a <button> - invalid HTML that screen readers and keyboard
              activation both handle unpredictably.
            */}
            <Link href="/" className={buttonVariants({ variant: "outline" })}>
              返回看板
            </Link>
            <Link href="/admin" className={buttonVariants({ variant: "ghost" })}>
              查看主数据
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
