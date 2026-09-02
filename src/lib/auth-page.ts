/**
 * Page-level admin guard.
 *
 * Kept in its own module - separate from `src/lib/auth.ts` - because this helper
 * THROWS. `redirect()` works by throwing a NEXT_REDIRECT signal that the framework
 * catches while rendering. That is the right behaviour for a Server Component (the
 * visitor lands on the login form) and the wrong behaviour inside a Server Action,
 * where the convention in this codebase is to RETURN a `{ ok: false, message }`
 * result the client can render next to the field that failed.
 *
 * So: pages call `requireAdminPage()`, actions call `requireAdmin()`. Never the
 * other way round.
 *
 * IMPORTANT - this is not the security boundary. A page guard only decides what
 * gets rendered. Server Actions execute regardless of which route the request was
 * addressed to (measured 2026-08-17; see the header of `src/lib/auth.ts` for the
 * method and the evidence). The load-bearing checks are the `requireAdmin()` calls
 * inside the ten action bodies. This guard exists so an unauthorised visitor sees a
 * login form instead of a page full of data they cannot change.
 */

import { redirect } from "next/navigation";

import { isAdmin } from "@/lib/auth";

/**
 * Redirect to the login form unless the caller holds a valid admin session.
 *
 * @param from - Path to return to after a successful login. Must be a site-relative
 *   path (the login action re-validates it and falls back to `/admin`, so a bad
 *   value here degrades to a harmless default rather than an open redirect).
 */
export async function requireAdminPage(from: string): Promise<void> {
  if (await isAdmin()) {
    return;
  }

  redirect(`/login?from=${encodeURIComponent(from)}`);
}
