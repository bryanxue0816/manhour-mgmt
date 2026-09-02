/**
 * Navigation-experience proxy. NOT a security boundary.
 *
 * Next.js 16.3 renamed this file convention from `middleware` to `proxy`; the runtime
 * and the build output still call the layer "Middleware" (`ƒ Proxy (Middleware)`), so
 * comments elsewhere that say "in middleware" mean this layer, not a missing file.
 *
 * Read this before you touch it:
 *
 * 1. This file cannot stop anybody. Measured 2026-08-17 on Next.js 16.3.0: a Server
 *    Action ID lifted out of `/admin` executes fine when POSTed to `/` - the public
 *    dashboard - because action dispatch is not bound to the route the action was
 *    declared in. Proxy sees `/`, waves the request through, and the admin
 *    action runs. The real checks are the `requireAdmin()` calls inside the ten
 *    action bodies. See the header of `src/lib/auth.ts` for the method and evidence.
 *
 * 2. It deliberately does NOT verify the cookie signature. `node:crypto` is not
 *    available in this runtime, and re-implementing HMAC verification here
 *    with Web Crypto would mean two copies of the rule that decides who is an
 *    administrator - the classic setup where one copy is fixed and the other is
 *    forgotten. A forged or expired cookie gets waved through here and is rejected by
 *    `requireAdminPage()` on the page and by `requireAdmin()` in every action.
 *
 * So all this does is: a visitor with no session cookie at all - the overwhelmingly
 * common case, a shop-floor user who clicked 管理 - is sent to the login form without
 * paying for a page render and a database round trip first.
 */

import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session-cookie";

export function proxy(request: NextRequest): NextResponse {
  // Presence only - see point 2 above. An empty value counts as absent because that
  // is what logout writes for clients that ignore cookie deletion.
  const cookie = request.cookies.get(SESSION_COOKIE);
  if (cookie !== undefined && cookie.value !== "") {
    return NextResponse.next();
  }

  const target = new URL("/login", request.url);
  target.searchParams.set("from", request.nextUrl.pathname);
  return NextResponse.redirect(target);
}

export const config = {
  /**
   * Only the protected routes. `/` stays out of this list on purpose: the dashboard is
   * public and must open with zero input from the user.
   *
   * Note this matches GET navigations to these paths. It does not - and cannot - cover
   * Server Action POSTs, which is why the list being right is a convenience, not a
   * defence. Adding a protected page here without also adding `requireAdminPage()` to
   * the page and `requireAdmin()` to its actions would be a real hole.
   */
  matcher: [
    "/plans",
    "/plans/import",
    "/actuals",
    "/actuals/import",
    "/admin",
    "/admin/audit",
  ],
};
