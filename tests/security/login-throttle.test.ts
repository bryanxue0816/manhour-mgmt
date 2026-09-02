// The login form is the only place an anonymous caller may submit a guess, so it is the
// only place that must slow itself down. This file is the regression test for the absence
// of that throttle: before 2026-08-18 a failed login produced one console.warn and nothing
// else, in an app whose admin password is a single shared string. On the intranet, at a few
// hundred requests per second, an unthrottled 4-digit password falls in under a minute.
//
// WHY THE LOAD-BEARING ASSERTION SUBMITS THE *CORRECT* PASSWORD:
// A test that submits a wrong password and expects rejection passes just as happily with
// the throttle deleted - `?error=bad` is what an unthrottled server answers too. The only
// observation an unthrottled server cannot produce is the RIGHT password being refused
// because the budget is spent. So the cap is measured the way an attacker would measure
// the hole: by whether a guess is evaluated at all.
//
// The real verifier runs throughout; nothing here mocks verifyPassword or the throttle. A
// stubbed gate keeps passing after the gate breaks (D-180).
//
// `next/navigation` is mocked to THROW, because the real `redirect()` throws and the code
// after each redirect call is only unreachable if it does. A mock that returned would let
// a throttled request fall through into the password check and the test would still pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Redirected extends Error {
  constructor(readonly location: string) {
    super(`redirect: ${location}`);
  }
}

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
  requestHeaders: { current: new Headers() },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet, delete: mocks.cookieDelete }),
  headers: async () => mocks.requestHeaders.current,
}));

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Redirected(location);
  },
}));

import { login } from "@/app/login/actions";
import {
  ATTEMPT_WINDOW_SECONDS,
  MAX_ATTEMPTS_PER_WINDOW,
  MAX_TRACKED_CLIENTS,
  UNKNOWN_CLIENT_KEY,
  clearAttempts,
  clientKeyFromHeaders,
  recordSuccess,
  registerAttempt,
  waitOut,
} from "@/lib/login-throttle";

/** Fixed clock. Never Date.now(): a window boundary that drifts is not a boundary. */
const NOW = 1_760_000_000_000;

const WINDOW_MS = ATTEMPT_WINDOW_SECONDS * 1000;

const PASSWORD = "correct horse battery staple";

const ENV_KEYS = ["SESSION_SECRET", "ADMIN_PASSWORD"] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.SESSION_SECRET = "a".repeat(64);
  process.env.ADMIN_PASSWORD = PASSWORD;

  clearAttempts();
  mocks.requestHeaders.current = new Headers({ "x-real-ip": "10.1.2.3" });
  mocks.cookieSet.mockReset();
  mocks.cookieDelete.mockReset();

  // login() logs every refusal. Silenced so a passing run is not a wall of warnings.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  clearAttempts();
});

/** Runs a login attempt and returns where it redirected to. */
async function attemptLogin(password: string, from?: string): Promise<string> {
  const form = new FormData();
  form.set("password", password);
  if (from !== undefined) {
    form.set("from", from);
  }
  try {
    await login(form);
  } catch (error) {
    if (error instanceof Redirected) {
      return error.location;
    }
    throw error;
  }
  throw new Error("login() returned without redirecting");
}

/** The `error=` flag carried back to the login page, or null on a successful redirect. */
function errorCode(location: string): string | null {
  return new URL(location, "http://intranet.invalid").searchParams.get("error");
}

/** Burns `count` attempts for a key without waiting out any delay. */
function burnAttempts(key: string, count: number, at = NOW): void {
  for (let index = 0; index < count; index += 1) {
    registerAttempt(key, at);
  }
}

describe("registerAttempt", () => {
  it("lets a first-time client through with no delay", () => {
    expect(registerAttempt("10.0.0.1", NOW)).toEqual({ allowed: true, delayMs: 0 });
  });

  it("charges a doubling delay that caps, leaving the first two attempts free", () => {
    const delays: number[] = [];
    for (let index = 0; index < MAX_ATTEMPTS_PER_WINDOW; index += 1) {
      const decision = registerAttempt("10.0.0.1", NOW);
      delays.push(decision.allowed ? decision.delayMs : -1);
    }
    expect(delays).toEqual([0, 0, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it("refuses the attempt after the budget is spent", () => {
    burnAttempts("10.0.0.1", MAX_ATTEMPTS_PER_WINDOW);
    expect(registerAttempt("10.0.0.1", NOW)).toEqual({
      allowed: false,
      retryAfterSeconds: ATTEMPT_WINDOW_SECONDS,
    });
  });

  it("never counts down for a client that keeps hammering", () => {
    // The window slides from the LAST attempt, so persistence is not rewarded. A fixed
    // window measured from the first attempt would hand out a fresh budget every 15
    // minutes no matter how hard the caller pushed.
    burnAttempts("10.0.0.1", MAX_ATTEMPTS_PER_WINDOW);
    const keepTrying = NOW + WINDOW_MS - 1;
    expect(registerAttempt("10.0.0.1", keepTrying).allowed).toBe(false);
    expect(registerAttempt("10.0.0.1", keepTrying + WINDOW_MS - 1).allowed).toBe(false);
  });

  it("forgives a client that stopped trying for a full window", () => {
    burnAttempts("10.0.0.1", MAX_ATTEMPTS_PER_WINDOW);
    expect(registerAttempt("10.0.0.1", NOW + WINDOW_MS + 1)).toEqual({
      allowed: true,
      delayMs: 0,
    });
  });

  it("does not hold a client blocked when the clock moves backwards", () => {
    // A record timestamped in the future is discarded rather than trusted: otherwise one
    // NTP correction could lock the administrators out until a restart.
    burnAttempts("10.0.0.1", MAX_ATTEMPTS_PER_WINDOW);
    expect(registerAttempt("10.0.0.1", NOW - 60_000).allowed).toBe(true);
  });

  it("counts each client separately", () => {
    burnAttempts("10.0.0.1", MAX_ATTEMPTS_PER_WINDOW);
    expect(registerAttempt("10.0.0.1", NOW).allowed).toBe(false);
    // The point of per-client counting: one machine guessing must not lock out the rest.
    // With a single shared password, a global counter would be a free denial of service.
    expect(registerAttempt("10.0.0.2", NOW)).toEqual({ allowed: true, delayMs: 0 });
  });

  it("forgets a client after recordSuccess", () => {
    burnAttempts("10.0.0.1", 2);
    recordSuccess("10.0.0.1");
    expect(registerAttempt("10.0.0.1", NOW)).toEqual({ allowed: true, delayMs: 0 });
  });

  it("bounds the tracked clients, evicting the least recently active first", () => {
    // Two attempts each, so a remembered client owes 500ms on its third and a forgotten
    // one owes 0. Without that the two cases are indistinguishable.
    for (let index = 0; index < MAX_TRACKED_CLIENTS; index += 1) {
      burnAttempts(`10.9.${index}`, 2, NOW + index);
    }

    // A new key forces room to be made. Nothing is stale, so the oldest goes.
    registerAttempt("10.8.0.1", NOW + MAX_TRACKED_CLIENTS);

    // Checked before the evicted key, because re-registering it makes room again.
    const newest = registerAttempt(`10.9.${MAX_TRACKED_CLIENTS - 1}`, NOW + MAX_TRACKED_CLIENTS);
    expect(newest).toEqual({ allowed: true, delayMs: 500 });

    const evicted = registerAttempt("10.9.0", NOW + MAX_TRACKED_CLIENTS);
    expect(evicted).toEqual({ allowed: true, delayMs: 0 });
  });
});

describe("clientKeyFromHeaders", () => {
  it("keys on X-Real-IP", () => {
    const source = new Headers({ "x-real-ip": "192.168.4.7" });
    expect(clientKeyFromHeaders(source)).toBe("192.168.4.7");
  });

  it("ignores X-Forwarded-For", () => {
    // The security property. X-Forwarded-For arrives from the client, so keying on it
    // would let one attacker mint a fresh, empty budget on every single request.
    const source = new Headers({
      "x-real-ip": "192.168.4.7",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(clientKeyFromHeaders(source)).toBe("192.168.4.7");
  });

  it("falls back to one shared bucket when no address is available", () => {
    // Deliberately not "no header means no throttle" - that would be a bypass rather
    // than a fallback.
    const source = new Headers({ "x-forwarded-for": "203.0.113.9" });
    expect(clientKeyFromHeaders(source)).toBe(UNKNOWN_CLIENT_KEY);
  });

  it("takes only the first entry if the header is ever a list", () => {
    const source = new Headers({ "x-real-ip": "192.168.4.7, 10.0.0.1" });
    expect(clientKeyFromHeaders(source)).toBe("192.168.4.7");
  });

  it("rejects a blank or oversized value instead of keying on junk", () => {
    expect(clientKeyFromHeaders(new Headers({ "x-real-ip": "   " }))).toBe(UNKNOWN_CLIENT_KEY);
    expect(clientKeyFromHeaders(new Headers({ "x-real-ip": "9".repeat(65) }))).toBe(
      UNKNOWN_CLIENT_KEY,
    );
  });
});

describe("login()", () => {
  // These cases cannot use the fixed NOW that the pure tests use: login() reads the real
  // clock internally, and a record stamped in 2025 would look stale - or, read the other
  // way, would look like the clock moved backwards - and be discarded. So the budget is
  // spent and inspected at the same real instant login() will see.
  const spendBudget = (ip: string): void => {
    burnAttempts(ip, MAX_ATTEMPTS_PER_WINDOW, Date.now());
  };

  it("refuses the CORRECT password once the budget is spent", async () => {
    // The one observation an unthrottled server cannot produce.
    spendBudget("10.1.2.3");
    expect(errorCode(await attemptLogin(PASSWORD))).toBe("throttled");
  });

  it("issues no session on the throttled path", async () => {
    spendBudget("10.1.2.3");
    await attemptLogin(PASSWORD);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("spends budget on every wrong guess it receives", async () => {
    expect(errorCode(await attemptLogin("wrong"))).toBe("bad");
    expect(errorCode(await attemptLogin("also wrong"))).toBe("bad");
    // Two attempts consumed, so the next one is the third and owes the first real delay.
    expect(registerAttempt("10.1.2.3", Date.now())).toEqual({ allowed: true, delayMs: 500 });
  });

  it("throttles per client, so one guessing machine cannot lock out an administrator", async () => {
    spendBudget("10.1.2.3");
    expect(errorCode(await attemptLogin(PASSWORD))).toBe("throttled");

    mocks.requestHeaders.current = new Headers({ "x-real-ip": "10.4.5.6" });
    await attemptLogin(PASSWORD);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });

  it("clears the budget after a correct password", async () => {
    await attemptLogin("wrong");
    await attemptLogin("wrong");
    await attemptLogin(PASSWORD);
    // Would owe 500ms as the third attempt if the successful login had not reset it.
    expect(registerAttempt("10.1.2.3", Date.now())).toEqual({ allowed: true, delayMs: 0 });
  });

  it("charges nothing when the server has no password configured", async () => {
    // Not a guess: there is nothing to guess. Charging here would let a misconfigured
    // deployment throttle the administrator who is trying to diagnose it.
    delete process.env.ADMIN_PASSWORD;
    expect(errorCode(await attemptLogin("anything"))).toBe("unset");
    expect(registerAttempt("10.1.2.3", Date.now())).toEqual({ allowed: true, delayMs: 0 });
  });

  it("cannot be given a fresh budget by spoofing X-Forwarded-For", async () => {
    spendBudget("10.1.2.3");
    mocks.requestHeaders.current = new Headers({
      "x-real-ip": "10.1.2.3",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(errorCode(await attemptLogin(PASSWORD))).toBe("throttled");
  });

  it("still carries the original destination through a throttled attempt", async () => {
    // The administrator lands back on the form with `from` intact, so waiting out the
    // window and logging in returns them to the page they wanted.
    spendBudget("10.1.2.3");
    const location = await attemptLogin(PASSWORD, "/plans/import");
    expect(new URL(location, "http://intranet.invalid").searchParams.get("from")).toBe(
      "/plans/import",
    );
  });
});

describe("waitOut", () => {
  it("resolves immediately when nothing is owed", async () => {
    await expect(waitOut(0)).resolves.toBeUndefined();
    await expect(waitOut(-1)).resolves.toBeUndefined();
  });

  it("waits at least the delay it was given", async () => {
    const before = performance.now();
    await waitOut(20);
    expect(performance.now() - before).toBeGreaterThanOrEqual(15);
  });
});
