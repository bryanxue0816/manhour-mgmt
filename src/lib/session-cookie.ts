/**
 * Session cookie constants, with no imports of their own.
 *
 * Split out of `src/lib/auth.ts` for one reason: `src/proxy.ts` needs the cookie
 * name, and importing it from `auth.ts` would pull `node:crypto` and `next/headers`
 * into the proxy bundle, where neither is available. Keeping the constants in a
 * dependency-free module means the proxy can name the cookie without dragging in
 * the machinery that verifies it.
 *
 * `auth.ts` re-exports both values, so existing imports from `@/lib/auth` keep working
 * and there is still only one definition of each.
 */

/** Session cookie name. Prefixed to avoid colliding with anything nginx may set. */
export const SESSION_COOKIE = "mh_admin";

/**
 * How long one login lasts.
 *
 * 30 days by decision: administrators use fixed office machines and a monthly
 * re-entry is friction they will tolerate, where a daily one would push them to
 * write the password on a sticky note - which is a worse outcome than a long cookie.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
