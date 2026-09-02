/**
 * Login and logout.
 *
 * Deliberately server-only: no client component, no useActionState. The form posts
 * straight to a Server Action, which either sets the cookie and redirects to the
 * originally requested page, or redirects back to /login with an error flag. That
 * keeps the one screen an unauthenticated visitor can reach free of any JavaScript
 * this app wrote, which is the smallest possible surface for the only page that
 * accepts a secret.
 *
 * These two actions are the ONE pair that must not call requireAdmin() - login is how
 * a caller becomes an administrator in the first place, and logout must work even
 * from an expired session so a shared machine can always be cleared.
 *
 * Being ungated is exactly why login is the one action that must throttle itself. It is
 * the only place where an anonymous caller gets to submit a guess, and nginx cannot slow
 * it down: the action id can be POSTed to any route, so a `limit_req` zone on /login never
 * sees the traffic. See src/lib/login-throttle.ts.
 */
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE,
  buildSessionValue,
  isPasswordConfigured,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";
import {
  clientKeyFromHeaders,
  recordSuccess,
  registerAttempt,
  waitOut,
} from "@/lib/login-throttle";

/** Where a bare login lands when no `from` was carried through. */
const DEFAULT_DESTINATION = "/admin";

/**
 * Constrains a post-login redirect to this site.
 *
 * Without this check `?from=https://evil.example` would turn the login form into an
 * open redirect: a link that looks like the company's own address bar but hands the
 * visitor to somebody else's page right after they typed the password.
 *
 * Rejects anything not starting with a single "/" - protocol-relative "//host" is a
 * full URL to a browser, and a backslash is normalised to a slash by some clients.
 */
function safeDestination(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    return DEFAULT_DESTINATION;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return DEFAULT_DESTINATION;
  }
  if (raw.includes("\\")) {
    return DEFAULT_DESTINATION;
  }
  return raw;
}

/**
 * Verifies the password and starts a session.
 *
 * Never reports WHICH part failed to the browser - a wrong password and an unset
 * ADMIN_PASSWORD both land on `?error=bad`. The one exception is the unconfigured
 * case, flagged separately as `?error=unset`, because that is not a user mistake and
 * the operator needs to be told to fix the environment rather than keep guessing.
 *
 * `?error=throttled` is a third exception, and it does leak that the caller has been
 * counted. That is acceptable: an attacker already learns it from the delay they just
 * waited out, while an administrator who is locked out otherwise sees "口令不正确" and
 * keeps trying a password that was right all along.
 */
export async function login(formData: FormData): Promise<void> {
  const destination = safeDestination(formData.get("from"));

  // Checked before the throttle: a server with no password configured cannot be guessed
  // at, so this path must not consume anybody's attempt budget.
  if (!isPasswordConfigured()) {
    console.error("[auth] ADMIN_PASSWORD is not set - login is impossible");
    redirect(`/login?error=unset&from=${encodeURIComponent(destination)}`);
  }

  const clientKey = clientKeyFromHeaders(await headers());
  const decision = registerAttempt(clientKey, Date.now());
  if (!decision.allowed) {
    // Deliberately returns without calling verifyPassword: the point of the cap is that
    // further guesses are not evaluated at all.
    console.warn(`[auth] login throttled for ${clientKey}`);
    redirect(`/login?error=throttled&from=${encodeURIComponent(destination)}`);
  }
  await waitOut(decision.delayMs);

  const submitted = formData.get("password");
  if (typeof submitted !== "string" || !verifyPassword(submitted)) {
    console.warn(`[auth] failed login attempt from ${clientKey}`);
    redirect(`/login?error=bad&from=${encodeURIComponent(destination)}`);
  }

  recordSuccess(clientKey);

  const built = buildSessionValue(Date.now());
  if (!built.ok) {
    // Correct password but the server cannot sign a cookie: SESSION_SECRET is missing
    // or too short. Refusing is the only safe answer - an unsigned session would be
    // forgeable by anyone.
    console.error(`[auth] cannot issue session: ${built.reason}`);
    redirect(`/login?error=unset&from=${encodeURIComponent(destination)}`);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, built.value, sessionCookieOptions());
  redirect(destination);
}

/**
 * Ends the session.
 *
 * Overwrites with an empty value at maxAge 0 rather than only calling delete(), so a
 * client that ignores deletion still ends up holding a value that fails verification.
 */
export async function logout(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  store.delete(SESSION_COOKIE);
  redirect("/");
}
