"use client";

/**
 * Last-resort error boundary: catches faults in the root layout itself.
 *
 * `error.tsx` is nested inside the root layout, so it cannot catch a throw from
 * that layout - if `layout.tsx` fails (a font fetch, a metadata evaluation, a
 * provider), the segment boundary never mounts. This file replaces the whole
 * document instead, which is why it must declare its own `<html>` and `<body>`:
 * the layout that normally supplies them is exactly what is broken.
 *
 * It also has to import `globals.css` itself. The stylesheet is pulled in by
 * `layout.tsx`, and that import goes down with the layout.
 *
 * No navigation links and no `<Link>`: client-side routing is owned by the router
 * that lives above this boundary, and the fault may well be in that region. A full
 * `location.reload()` is the only recovery that is certain not to depend on the
 * broken part. This page should essentially never be seen - if it is, something
 * structural is wrong and a full reload beats a soft retry.
 */

import { useEffect } from "react";

import "./globals.css";

export interface GlobalErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalErrorPage({ error, reset }: GlobalErrorPageProps) {
  useEffect(() => {
    console.error("[manhour] root layout error", error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <div className="mx-auto max-w-2xl px-6 py-16">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-destructive uppercase">
            Fatal
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">系统无法启动页面框架</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            错误发生在页面外层框架，因此本次没有加载任何工时数据。请刷新重试；若持续失败，请联系系统管理员并提供下方追踪码。
          </p>

          <dl className="mt-6 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-sm">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">错误</dt>
              <dd className="min-w-0 font-mono text-xs break-words">
                {error.message === "" ? "（无消息）" : error.message}
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">追踪码</dt>
              <dd className="min-w-0 font-mono text-xs break-words">
                {error.digest ?? "（无 · 该错误发生在浏览器端）"}
              </dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              重试
            </button>
            <button
              type="button"
              // A real document reload, not client-side routing. `<Link>` (and a plain
              // <a>, which eslint rightly rewrites to one) hands navigation to the
              // router that lives ABOVE this boundary - and that region is what just
              // failed. `location.reload()` throws the whole document away, which is
              // the only recovery that does not depend on the broken part.
              onClick={() => {
                window.location.reload();
              }}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              完整刷新
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
