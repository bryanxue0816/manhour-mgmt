// The administrator gate. This module is the ONLY thing standing between the public
// intranet and every write in the system, because a Server Action executes no matter
// which route it is POSTed to (measured 2026-08-17 - see the header of src/lib/auth.ts).
// nginx rules, middleware matchers and hidden nav links gate navigation, not POSTs.
//
// So the assertions here are not about message wording. Two properties are load-bearing:
//
//   1. FAIL CLOSED. Every misconfiguration - absent secret, short secret, absent
//      password - must DENY. The failure mode being guarded against is a deployment
//      that silently admits everybody because someone forgot a variable.
//
//   2. ONLY THIS SERVER'S OWN SIGNATURE COUNTS. A cookie whose timestamp was edited,
//      whose signature was edited, or which was signed with a different secret must be
//      refused. Anything the client can write is not a credential.
//
// `next/headers` is mocked because `cookies()` is only reachable inside a request scope.
// The store is a bare object rather than a partial mock of the real module: nothing else
// in that module is used here, and a real one would drag in the Next.js request context.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn<(name: string) => { name: string; value: string } | undefined>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.get }),
}));

import {
  DENIED_MESSAGE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  buildSessionValue,
  generateSecret,
  isAdmin,
  isPasswordConfigured,
  readSession,
  requireAdmin,
  sessionCookieOptions,
  verifyPassword,
  verifySessionValue,
} from "@/lib/auth";

/** 64 hex chars - long enough to pass MIN_SECRET_LENGTH with room to spare. */
const SECRET = "a".repeat(64);

/** A second, unrelated secret, standing in for one that has been rotated. */
const OTHER_SECRET = "b".repeat(64);

/** Fixed clock. Never Date.now(): a boundary test that drifts is not a boundary test. */
const NOW = 1_760_000_000_000;

/** Signs a timestamp the way the module does, so tests can forge and rotate at will. */
function signedAt(issuedAt: number, secret = SECRET): string {
  const payload = String(issuedAt);
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

const ENV_KEYS = ["SESSION_SECRET", "ADMIN_PASSWORD", "COOKIE_SECURE"] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  // The module reads process.env at CALL time, not import time, so each test can set up
  // its own deployment. Saved and restored by hand: vitest's restoreMocks does not touch
  // env, and a leaked SESSION_SECRET would make the fail-closed tests pass vacuously.
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.SESSION_SECRET = SECRET;
  process.env.ADMIN_PASSWORD = "correct horse";
  delete process.env.COOKIE_SECURE;

  mocks.get.mockReset();
  mocks.get.mockReturnValue(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("verifySessionValue - accepts only what this server signed", () => {
  it("accepts a cookie it just built", () => {
    const built = buildSessionValue(NOW);

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const check = verifySessionValue(built.value, NOW);

    expect(check).toEqual({ ok: true, session: { issuedAt: NOW } });
  });

  it("rejects a cookie whose signature was edited", () => {
    const valid = signedAt(NOW);
    // Flip the last hex digit only. A forger who can change one bit can change all of
    // them, so if this passed, the signature would be decoration.
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;

    expect(verifySessionValue(tampered, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a cookie whose timestamp was edited to extend it", () => {
    // The interesting attack is not "make it invalid" - it is re-dating an expired
    // cookie to today while keeping the signature that was valid for the old date.
    const expiredAt = NOW - (SESSION_MAX_AGE_SECONDS + 1) * 1000;
    const signature = signedAt(expiredAt).split(".")[1];

    expect(verifySessionValue(`${NOW}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a cookie signed with a rotated-away secret", () => {
    // Rotating SESSION_SECRET must invalidate every outstanding session. Administrators
    // log in again; a captured cookie stops working.
    expect(verifySessionValue(signedAt(NOW, OTHER_SECRET), NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
});

describe("verifySessionValue - rejects malformed input before doing crypto", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
  ])("reports %s as no-cookie", (_label, raw) => {
    expect(verifySessionValue(raw, NOW)).toEqual({ ok: false, reason: "no-cookie" });
  });

  it.each([
    ["no separator", "1760000000000"],
    ["two separators", `${signedAt(NOW)}.extra`],
    ["an empty timestamp", `.${"a".repeat(64)}`],
    ["a non-numeric timestamp", `abc.${"a".repeat(64)}`],
    ["a negative timestamp", `-1.${"a".repeat(64)}`],
    ["a 16-digit timestamp", `1234567890123456.${"a".repeat(64)}`],
    ["a short signature", `${NOW}.${"a".repeat(63)}`],
    ["a long signature", `${NOW}.${"a".repeat(65)}`],
    ["an uppercase signature", `${NOW}.${"A".repeat(64)}`],
    ["a non-hex signature", `${NOW}.${"z".repeat(64)}`],
  ])("reports %s as malformed", (_label, raw) => {
    expect(verifySessionValue(raw, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a value that would split differently than it was signed", () => {
    // Requiring EXACTLY two parts is what stops a forger from moving the split point so
    // a signature computed over one payload validates a different one.
    const signature = signedAt(NOW).split(".")[1];

    expect(verifySessionValue(`${NOW}.${signature}.`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("verifySessionValue - expiry", () => {
  it("accepts a cookie at exactly the maximum age", () => {
    const issuedAt = NOW - SESSION_MAX_AGE_SECONDS * 1000;

    expect(verifySessionValue(signedAt(issuedAt), NOW).ok).toBe(true);
  });

  it("rejects a cookie one second past the maximum age", () => {
    const issuedAt = NOW - (SESSION_MAX_AGE_SECONDS + 1) * 1000;

    expect(verifySessionValue(signedAt(issuedAt), NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a cookie issued in the future", () => {
    // The signature is genuine, so this is a clock that moved backwards - or a cookie
    // minted while the clock was wrong. Either way a future date must not buy extra
    // validity beyond the window.
    expect(verifySessionValue(signedAt(NOW + 60_000), NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("holds the window at 30 days", () => {
    // Not arbitrary: a shorter window pushes operators to write the password down, a
    // longer one keeps a captured cookie alive past any staff change.
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe("fail closed on a misconfigured secret", () => {
  it("denies a genuine cookie when SESSION_SECRET is absent", () => {
    const valid = signedAt(NOW);
    delete process.env.SESSION_SECRET;

    expect(verifySessionValue(valid, NOW)).toEqual({ ok: false, reason: "no-secret" });
  });

  it("denies a genuine cookie when SESSION_SECRET is empty", () => {
    const valid = signedAt(NOW);
    process.env.SESSION_SECRET = "";

    expect(verifySessionValue(valid, NOW)).toEqual({ ok: false, reason: "no-secret" });
  });

  it("denies when SESSION_SECRET is shorter than 32 characters", () => {
    // 31 chars: a placeholder someone forgot to replace looks exactly like this.
    process.env.SESSION_SECRET = "x".repeat(31);

    expect(verifySessionValue(signedAt(NOW), NOW)).toEqual({
      ok: false,
      reason: "secret-too-short",
    });
  });

  it("accepts a secret at exactly 32 characters", () => {
    const shortest = "y".repeat(32);
    process.env.SESSION_SECRET = shortest;

    expect(verifySessionValue(signedAt(NOW, shortest), NOW).ok).toBe(true);
  });

  it("refuses to BUILD a session without a usable secret", () => {
    // The login action relies on this: no secret means the operator is told the server
    // is unconfigured, rather than being handed a cookie that nothing can verify.
    delete process.env.SESSION_SECRET;

    expect(buildSessionValue(NOW)).toEqual({ ok: false, reason: "no-secret" });
  });
});

describe("verifyPassword", () => {
  it("accepts the configured password", () => {
    expect(verifyPassword("correct horse")).toBe(true);
  });

  it.each([
    ["a wrong password", "wrong horse"],
    ["a case variation", "Correct Horse"],
    ["a prefix", "correct"],
    ["the password with trailing whitespace", "correct horse "],
    ["an empty submission", ""],
  ])("rejects %s", (_label, submitted) => {
    expect(verifyPassword(submitted)).toBe(false);
  });

  it.each([
    ["a non-string submission", 42 as unknown as string],
    ["null", null as unknown as string],
    ["undefined", undefined as unknown as string],
  ])("rejects %s without throwing", (_label, submitted) => {
    expect(verifyPassword(submitted)).toBe(false);
  });

  it("denies everybody when ADMIN_PASSWORD is unset", () => {
    delete process.env.ADMIN_PASSWORD;

    expect(verifyPassword("correct horse")).toBe(false);
    expect(verifyPassword("")).toBe(false);
    expect(isPasswordConfigured()).toBe(false);
  });

  it("treats an EMPTY ADMIN_PASSWORD as unconfigured, not as a blank password", () => {
    // The dangerous reading of `ADMIN_PASSWORD=` in a .env file is "no password
    // required". It must mean "nobody gets in".
    process.env.ADMIN_PASSWORD = "";

    expect(verifyPassword("")).toBe(false);
    expect(isPasswordConfigured()).toBe(false);
  });

  it("reports a configured password as configured", () => {
    expect(isPasswordConfigured()).toBe(true);
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, lax and site-wide regardless of environment", () => {
    // httpOnly is what keeps an XSS from reading the session; path "/" is required
    // because the cookie is checked on / as well as the protected routes.
    const options = sessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("defaults `secure` to false because nginx serves plain HTTP", () => {
    // Not an oversight. nginx.conf listens on port 80 only, and a secure cookie is never
    // sent back over plain HTTP - flipping this default would lock every administrator
    // out with no error message anywhere.
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it("sets `secure` only for the exact string \"true\"", () => {
    process.env.COOKIE_SECURE = "true";
    expect(sessionCookieOptions().secure).toBe(true);

    for (const value of ["TRUE", "1", "yes", "false", ""]) {
      process.env.COOKIE_SECURE = value;
      expect(sessionCookieOptions().secure).toBe(false);
    }
  });
});

describe("readSession / isAdmin / requireAdmin - reading the request cookie", () => {
  /** Puts a cookie in the mocked store, as the browser would send it. */
  function present(value: string): void {
    mocks.get.mockImplementation((name) =>
      name === SESSION_COOKIE ? { name, value } : undefined,
    );
  }

  it("reads the session out of the cookie named mh_admin", () => {
    // Pinned deliberately: src/middleware.ts checks this same name via
    // session-cookie.ts. If the name drifts, navigation and authorisation disagree.
    expect(SESSION_COOKIE).toBe("mh_admin");
  });

  it("admits a request carrying a valid cookie", async () => {
    present(signedAt(NOW));

    await expect(readSession(NOW)).resolves.toEqual({
      ok: true,
      session: { issuedAt: NOW },
    });
  });

  it("admits isAdmin() against the real clock", async () => {
    // isAdmin() takes no clock argument, so the cookie has to be dated NOW-ish in real
    // time rather than at the fixed NOW above - which is itself the point: a cookie from
    // a fixed date in the past is correctly expired by the wall clock.
    present(signedAt(Date.now()));

    await expect(isAdmin()).resolves.toBe(true);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    present(signedAt(NOW));

    await expect(isAdmin()).resolves.toBe(false);
  });

  it("denies a request with no cookie at all", async () => {
    await expect(isAdmin()).resolves.toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = await requireAdmin();

    expect(gate).toEqual({ ok: false, message: DENIED_MESSAGE });
    // The reason goes to the operator's log, never to the browser.
    expect(warn).toHaveBeenCalledWith("[auth] denied: no-cookie");
  });

  it("denies a forged cookie", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    present(signedAt(NOW, OTHER_SECRET));

    await expect(isAdmin()).resolves.toBe(false);
    expect((await requireAdmin()).ok).toBe(false);
    expect(warn).toHaveBeenCalledWith("[auth] denied: bad-signature");
  });

  it("tells the browser the same thing whatever went wrong", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const messages = new Set<string>();
    for (const value of ["", "garbage", signedAt(NOW, OTHER_SECRET), signedAt(0)]) {
      present(value);
      const gate = await requireAdmin();
      if (!gate.ok) messages.add(gate.message);
    }

    // One message for every failure. Telling a caller whether the cookie was missing,
    // expired or forged is free reconnaissance.
    expect(messages).toEqual(new Set([DENIED_MESSAGE]));
    expect(DENIED_MESSAGE).not.toMatch(/cookie|signature|expired|secret/i);
  });

  it("ignores cookies with other names", async () => {
    mocks.get.mockImplementation((name) =>
      name === "some_other_cookie" ? { name, value: signedAt(NOW) } : undefined,
    );

    await expect(isAdmin()).resolves.toBe(false);
  });
});

describe("generateSecret", () => {
  it("produces a 64-character hex secret that passes the length rule", () => {
    const secret = generateSecret();

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("produces a different secret each time", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});
