/**
 * Per-client throttle for the login form.
 *
 * WHY THIS IS NOT IN nginx.conf
 * A `limit_req` zone on `/login` would never fire. `login` is a Server Action, and a
 * Server Action executes no matter which route it is POSTed to - measured 2026-08-17,
 * see the header of src/lib/auth.ts. An attacker POSTs the login action id to `/`, nginx
 * sees a request for the public dashboard, and the rate limit on `/login` sits idle.
 * This is the same reasoning that puts `requireAdmin()` inside all ten write actions
 * rather than in middleware: the only place a check binds to the code being called is
 * inside the action body.
 *
 * WHY PER-CLIENT AND NOT ACCOUNT LOCKOUT
 * There is one shared administrator password and no user table (D-008, D-180). A global
 * lockout after N failures would therefore be a free denial of service: anybody who can
 * reach the form could lock out every administrator by typing the wrong password ten
 * times. Counting per client keeps the cost on the machine that is guessing.
 *
 * THE KEY IS X-Real-IP, NOT X-Forwarded-For
 * nginx.conf:164 sets `X-Real-IP $remote_addr` - the peer's real address, written by our
 * own proxy and not settable by the client. `X-Forwarded-For` arrives from the client and
 * is trivially spoofed (nginx.conf:101-103 says so explicitly); keying on it would let an
 * attacker mint a fresh bucket per request.
 *
 * RESIDUAL RISKS, recorded rather than hidden:
 *   - A caller who reaches the app port directly, bypassing nginx, controls X-Real-IP and
 *     can rotate it. The answer is topology, not code: docker-compose publishes only
 *     nginx, and D-171's address whitelist already depends on nginx being the first hop.
 *   - Counters live in this process's memory. A restart clears them, and that is
 *     accepted: the deployment is a single standalone process (D-180), a restart is a
 *     manual operator action, and an attacker cannot trigger one.
 *   - A throttle buys time; it does not rescue a small keyspace. Ten guesses per window
 *     still walks a 100-candidate password in hours. Password strength is a separate,
 *     non-negotiable requirement (D-181).
 */

/** How long a client's attempt history is remembered, measured from its LAST attempt. */
export const ATTEMPT_WINDOW_SECONDS = 15 * 60;

/** Guesses allowed inside one window before the password stops being checked at all. */
export const MAX_ATTEMPTS_PER_WINDOW = 10;

/**
 * Upper bound on tracked clients, so the map cannot grow without limit.
 *
 * Far above the size of any single intranet segment that reaches this system, and small
 * enough that the whole map stays negligible in memory.
 */
export const MAX_TRACKED_CLIENTS = 1024;

/**
 * Delay applied before the password is checked, indexed by attempt number - 1.
 *
 * The first two attempts are free because typing a password wrong twice is ordinary human
 * behaviour, and punishing it teaches administrators to write the password down. From the
 * third the cost doubles, capped so that a legitimate operator who has forgotten which
 * password is current is never stuck for more than a few seconds.
 */
const DELAY_SCHEDULE_MS: readonly number[] = [0, 0, 500, 1_000, 2_000, 4_000, 8_000];

/** Longest client key kept. A real address is far shorter; anything longer is junk. */
const MAX_KEY_LENGTH = 64;

/**
 * Bucket shared by every caller that arrives without a usable address.
 *
 * Sharing one bucket is deliberate. Treating a missing header as "no throttle" would be a
 * bypass anyone could use; treating it as one crowded bucket means the unattributable
 * traffic throttles itself.
 */
export const UNKNOWN_CLIENT_KEY = "unknown";

type AttemptRecord = {
  /** Attempts inside the current window, capped at MAX_ATTEMPTS_PER_WINDOW. */
  readonly count: number;
  /** Timestamp of the most recent attempt, in epoch milliseconds. */
  readonly lastAttemptAt: number;
};

const attempts = new Map<string, AttemptRecord>();

export type ThrottleDecision =
  /** The password may be checked, after waiting `delayMs`. */
  | { readonly allowed: true; readonly delayMs: number }
  /** Too many attempts. The password must not be checked at all. */
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Reads the throttle key out of a request's headers.
 *
 * Typed structurally rather than against `next/headers`, so this stays a pure function
 * that a test can call with a plain `Headers`.
 */
export function clientKeyFromHeaders(source: { get(name: string): string | null }): string {
  const raw = source.get("x-real-ip");
  if (typeof raw !== "string") {
    return UNKNOWN_CLIENT_KEY;
  }
  // Only the first entry matters if some intermediary ever appends to the header.
  const first = (raw.split(",")[0] ?? "").trim();
  if (first === "" || first.length > MAX_KEY_LENGTH) {
    return UNKNOWN_CLIENT_KEY;
  }
  return first;
}

/** Delay owed by the given attempt number (1-based). */
function delayForAttempt(attemptNumber: number): number {
  const index = Math.min(Math.max(attemptNumber, 1), DELAY_SCHEDULE_MS.length) - 1;
  return DELAY_SCHEDULE_MS[index] ?? 0;
}

/** True when a record is old enough - or timestamped oddly enough - to be ignored. */
function isStale(record: AttemptRecord, now: number): boolean {
  // A record from the future means the clock moved backwards. Trusting it would let a
  // clock change hold a client blocked indefinitely, so it is discarded instead.
  return now < record.lastAttemptAt || now - record.lastAttemptAt > ATTEMPT_WINDOW_SECONDS * 1000;
}

/**
 * Enforces MAX_TRACKED_CLIENTS before a new key is inserted.
 *
 * Expired records go first. If none have expired, the least recently active record is
 * dropped - deliberately that order, because a client currently hammering the form has
 * the NEWEST timestamp and is therefore the last thing evicted.
 */
function makeRoom(now: number): void {
  if (attempts.size < MAX_TRACKED_CLIENTS) {
    return;
  }

  for (const [key, record] of attempts) {
    if (isStale(record, now)) {
      attempts.delete(key);
    }
  }
  if (attempts.size < MAX_TRACKED_CLIENTS) {
    return;
  }

  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, record] of attempts) {
    if (record.lastAttemptAt < oldestAt) {
      oldestAt = record.lastAttemptAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    attempts.delete(oldestKey);
  }
}

/**
 * Counts one login attempt and says what it costs.
 *
 * Counting happens BEFORE the password is checked, and synchronously. That ordering is
 * the part that matters: if the count were incremented only after a failed check, a burst
 * of concurrent requests would all read the same low count during the `await` and every
 * one of them would be let through at the cheapest rate. Charging the attempt up front
 * means the eleventh request in a burst sees ten already recorded.
 *
 * The window slides from the most recent attempt, so a client that keeps hammering never
 * counts down to release - and that refusal is cheap, because it does no hashing and no
 * waiting.
 */
export function registerAttempt(clientKey: string, now: number): ThrottleDecision {
  const existing = attempts.get(clientKey);
  const carried = existing === undefined || isStale(existing, now) ? 0 : existing.count;

  if (existing === undefined) {
    makeRoom(now);
  }

  attempts.set(clientKey, {
    count: Math.min(carried + 1, MAX_ATTEMPTS_PER_WINDOW),
    lastAttemptAt: now,
  });

  if (carried >= MAX_ATTEMPTS_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: ATTEMPT_WINDOW_SECONDS };
  }
  return { allowed: true, delayMs: delayForAttempt(carried + 1) };
}

/**
 * Forgets a client's attempts after a correct password.
 *
 * Without this an administrator who mistyped twice would keep paying for it all window.
 * It is not a hole: reaching this point required the password.
 */
export function recordSuccess(clientKey: string): void {
  attempts.delete(clientKey);
}

/**
 * Drops all counters.
 *
 * Exists for tests, which need a clean map per case. It is also the only in-process way
 * to release an administrator who locked themselves out - equivalent to restarting the
 * container, and intentionally not reachable over HTTP.
 */
export function clearAttempts(): void {
  attempts.clear();
}

/** Sleeps out a throttle delay. Resolves immediately when nothing is owed. */
export async function waitOut(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
