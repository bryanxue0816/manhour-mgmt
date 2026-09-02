/**
 * Administrator gate for every write in the system.
 *
 * WHY THIS EXISTS AT THE ACTION LEVEL AND NOWHERE ELSE
 *
 * Measured on 2026-08-17: all five `/admin` Server Actions were invoked successfully
 * by POSTing to `/` (the public dashboard) with a `Next-Action` header carrying the
 * action id. Every one returned its own validation error - proof it had executed -
 * with no navigation to /admin at all. A Server Action's execution is NOT bound to
 * the route it was declared in; the id resolves against a global manifest.
 *
 * The consequence is the whole design constraint of this module:
 *
 *   - nginx path rules, `src/proxy.ts` matchers, page-level render checks and hidden
 *     nav links all gate NAVIGATION. None of them gate a POST.
 *   - Therefore the only load-bearing check is `requireAdmin()` called INSIDE each of
 *     the 10 action bodies. `src/proxy.ts` and the nav are user experience, not
 *     security. Do not remove an in-action check because "the proxy already
 *     handles it" - it does not.
 *
 * Request-supplied signals cannot be credentials either. Referer, Origin and the
 * request path are all written by the client; the probe above sent whatever it liked.
 * The only thing that can be trusted is a value this server signed itself, which is
 * what the session cookie is.
 *
 * FAIL CLOSED
 *
 * Missing or short SESSION_SECRET denies everyone rather than admitting everyone. A
 * misconfigured deployment must lock the administrator out, never let the public in.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session-cookie";

/**
 * Re-exported so callers keep a single import site (`@/lib/auth`) for everything
 * session-related. The values live in `session-cookie.ts` because the middleware needs
 * the name without the crypto - see that file's header.
 */
export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS };

/**
 * Rejects a secret too short to be worth signing with.
 *
 * 32 hex chars = 128 bits. Below that an offline forgery attempt against a captured
 * cookie becomes conceivable, and a short secret is nearly always a placeholder that
 * someone forgot to replace.
 */
const MIN_SECRET_LENGTH = 32;

/** Reason a gate refused, for the operator's log. Never shown to the browser. */
type DenyReason =
  | "no-secret"
  | "secret-too-short"
  | "no-cookie"
  | "malformed"
  | "bad-signature"
  | "expired";

/**
 * The single user-facing refusal message.
 *
 * Deliberately identical for every DenyReason. Telling the caller whether the cookie
 * was absent, expired or forged is free reconnaissance; the operator gets the detail
 * in the server log instead.
 */
export const DENIED_MESSAGE = "需要管理员权限。请先登录后再操作。";

/** Session payload, recovered from a cookie that verified. */
export interface AdminSession {
  /** Epoch ms the session was issued. */
  issuedAt: number;
}

export type SessionCheck =
  | { ok: true; session: AdminSession }
  | { ok: false; reason: DenyReason };

/**
 * Reads the signing secret.
 *
 * @returns the secret, or a DenyReason. Read at call time rather than module load so
 *   a secret rotated in the environment takes effect on the next request instead of
 *   requiring a rebuild, and so importing this module can never throw at boot.
 */
function readSecret(): { ok: true; secret: string } | { ok: false; reason: DenyReason } {
  const secret = process.env.SESSION_SECRET;
  if (typeof secret !== "string" || secret === "") {
    return { ok: false, reason: "no-secret" };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: "secret-too-short" };
  }
  return { ok: true, secret };
}

/** HMAC-SHA256 of the payload, hex. */
function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length, so
 * both sides are hashed to a fixed 32 bytes first and the digests are compared.
 */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHmac("sha256", "cmp").update(a).digest();
  const digestB = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Verifies a cookie value without touching the request store.
 *
 * Exported so tests can exercise every branch as a pure function - the cookie store
 * is only reachable inside a request scope.
 */
export function verifySessionValue(raw: string | undefined, now: number): SessionCheck {
  const secretResult = readSecret();
  if (!secretResult.ok) {
    return { ok: false, reason: secretResult.reason };
  }
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, reason: "no-cookie" };
  }

  // Exactly one separator: an issuedAt containing a dot would otherwise let a forger
  // shift the split point and re-use a valid signature over different bytes.
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [issuedAtRaw, signature] = parts as [string, string];
  if (!/^\d{1,15}$/.test(issuedAtRaw) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  if (!safeEqual(sign(issuedAtRaw, secretResult.secret), signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  // Signature verified, so issuedAt is this server's own number - but the clock could
  // still have moved backwards, and a future timestamp must not extend a session.
  const issuedAt = Number(issuedAtRaw);
  const ageSeconds = (now - issuedAt) / 1000;
  if (ageSeconds < 0 || ageSeconds > SESSION_MAX_AGE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, session: { issuedAt } };
}

/** Builds a fresh signed cookie value. Caller writes it to the cookie store. */
export function buildSessionValue(now: number): { ok: true; value: string } | { ok: false; reason: DenyReason } {
  const secretResult = readSecret();
  if (!secretResult.ok) {
    return { ok: false, reason: secretResult.reason };
  }
  const issuedAt = String(now);
  return { ok: true, value: `${issuedAt}.${sign(issuedAt, secretResult.secret)}` };
}

/**
 * Compares a submitted password against ADMIN_PASSWORD.
 *
 * Fails closed when unset: with no configured password nobody can log in, which locks
 * the administrator out of a misconfigured deployment rather than opening it up.
 */
export function verifyPassword(submitted: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (typeof expected !== "string" || expected === "") {
    return false;
  }
  if (typeof submitted !== "string" || submitted === "") {
    return false;
  }
  return safeEqual(submitted, expected);
}

/** True when ADMIN_PASSWORD is configured, so the login page can say so plainly. */
export function isPasswordConfigured(): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  return typeof expected === "string" && expected !== "";
}

/**
 * Cookie attributes used for both setting and clearing.
 *
 * `secure` is FALSE by default on purpose. nginx.conf listens on port 80 only - there
 * is no TLS on the intranet deployment - and a `secure` cookie is never sent back
 * over plain HTTP, so enabling it here would lock every administrator out with no
 * visible error. Set COOKIE_SECURE=true only after the deployment actually terminates
 * TLS. The tradeoff being accepted: over plain HTTP both the password and the cookie
 * are visible to anyone capturing intranet traffic.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Reads the current request's session.
 *
 * Safe in both Server Components and Server Actions - it only reads.
 */
export async function readSession(now: number = Date.now()): Promise<SessionCheck> {
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE)?.value, now);
}

/** Convenience predicate for pages and the nav. */
export async function isAdmin(): Promise<boolean> {
  return (await readSession()).ok;
}

/**
 * The gate every Server Action must call before its first write.
 *
 * Returns rather than throws, matching the convention in the action modules: a thrown
 * Server Action reaches the client as an opaque digest in production, so the operator
 * would see a crash instead of "please log in".
 *
 * @example
 *   const gate = await requireAdmin();
 *   if (!gate.ok) return reject(gate.message);
 */
export async function requireAdmin(): Promise<
  { ok: true; session: AdminSession } | { ok: false; message: string }
> {
  const check = await readSession();
  if (check.ok) {
    return { ok: true, session: check.session };
  }
  // Server-side only: the browser gets DENIED_MESSAGE with no detail.
  console.warn(`[auth] denied: ${check.reason}`);
  return { ok: false, message: DENIED_MESSAGE };
}

/**
 * Generates a secret suitable for SESSION_SECRET.
 *
 * Lives here rather than in a script so the length rule above and the generator can
 * never drift apart.
 */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}
