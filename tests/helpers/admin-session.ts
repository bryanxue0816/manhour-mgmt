// A valid administrator session, for tests of code that now sits behind requireAdmin().
//
// Since 2026-08-17 every Server Action calls requireAdmin() before it does anything else
// (see src/lib/auth.ts for the measured bypass that forced the check into the action
// bodies). That makes `cookies()` reachable from any action test, and `cookies()` throws
// outside a request scope - so a test of validation or repository behaviour has to
// present a session first, or it never reaches the code it is about.
//
// This helper exists so that setup is one line per file instead of a copied block of
// HMAC construction. It deliberately builds a REAL signed cookie and lets the real
// verifier accept it, rather than mocking requireAdmin: a stubbed gate would keep passing
// after the gate itself broke.
//
// Not collected as a test file - vitest.config.mts only includes `tests/**/*.test.ts`.

import { createHmac } from "node:crypto";

import type { Mock } from "vitest";

/** Long enough to clear MIN_SECRET_LENGTH in src/lib/auth.ts. Test-only value. */
export const TEST_SESSION_SECRET = "test-secret-".padEnd(64, "0");

/** Must match SESSION_COOKIE in src/lib/session-cookie.ts - pinned by tests/lib/auth.test.ts. */
export const SESSION_COOKIE_NAME = "mh_admin";

/** One cookie value, signed the way src/lib/auth.ts signs it. */
export function adminCookieValue(issuedAt: number = Date.now()): string {
  const payload = String(issuedAt);
  const signature = createHmac("sha256", TEST_SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

/**
 * Configures the environment and the mocked cookie store so requireAdmin() admits.
 *
 * @param cookieGet the `get` of a `cookies()` mock, e.g.
 *   `vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet }) }))`
 *
 * Call it in `beforeEach`, after resetting the mock: the session is dated at call time so
 * it can never drift into the expiry window.
 */
export function grantAdminSession(
  cookieGet: Mock<(name: string) => { name: string; value: string } | undefined>,
): void {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  const value = adminCookieValue();
  cookieGet.mockImplementation((name) =>
    name === SESSION_COOKIE_NAME ? { name, value } : undefined,
  );
}
