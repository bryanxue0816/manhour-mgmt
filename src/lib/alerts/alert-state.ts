// Frequency-control state for the attendance alert channel, persisted as one
// JSON file next to the SQLite database (the /app/data bind mount in the
// container). Every transition is a pure function returning a new object; the
// only IO is readAlertState()/writeAlertState(). A missing or corrupt file is
// indistinguishable from "first scan": readAlertState() returns null and the
// caller re-baselines, so the file is self-healing and needs no backup.

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALERT_STATE_SCHEMA_VERSION = 1;

export type AlertTrackedState = "ok" | "stale" | "baseline";

export interface AlertState {
  schemaVersion: 1;
  lastState: AlertTrackedState;
  firstAlertDate: string | null; // YYYY-MM-DD, business calendar day
  lastAlertDate: string | null; // YYYY-MM-DD
  lastRecoveryDate: string | null; // YYYY-MM-DD
  lastCheckAt: string | null; // ISO-8601 with +08:00 offset
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

export type AlertIntentKind = "send-first" | "send-repeat" | "send-recovery";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRACKED_STATES: readonly AlertTrackedState[] = ["ok", "stale", "baseline"];
const STATE_FILE_NAME = "alert-state.json";

/**
 * Renders an instant as an ISO string pinned to the business zone, e.g.
 * 2026-09-11T01:20:00.000Z -> "2026-09-11T09:20:00+08:00". Built from Intl parts
 * so the host clock/time zone cannot change the output. h23 keeps midnight "00".
 */
export function toStateInstant(now: Date): string {
  const parts = STATE_INSTANT_FORMAT.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

const STATE_INSTANT_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Locates alert-state.json next to the SQLite file DATABASE_URL points at, so it
 * lands on the same bind mount. POSIX absolute `file:` URLs (container value
 * file:/app/data/dev.db) are handled by string slicing on purpose: converting
 * them on a Windows dev machine would mangle the path, and that value only ever
 * runs inside the Linux container. Relative URLs resolve against process.cwd().
 */
export function alertStatePathFor(databaseUrl: string | undefined): string {
  const raw = (databaseUrl ?? "").trim();
  if (raw === "") {
    return join(dirname(join(process.cwd(), "dev.db")), STATE_FILE_NAME);
  }
  if (!raw.startsWith("file:")) {
    // A bare filesystem path.
    return join(dirname(raw), STATE_FILE_NAME);
  }
  const base = pathToFileURL(join(process.cwd(), "state-base"));
  const url = new URL(raw, base);
  const pathname = decodeURIComponent(url.pathname);
  const isWindowsDrive = /^\/[A-Za-z]:[\\/]/.test(pathname);
  if (isWindowsDrive) {
    return join(dirname(fileURLToPath(url)), STATE_FILE_NAME);
  }
  const lastSlash = pathname.lastIndexOf("/");
  return `${pathname.slice(0, lastSlash)}/${STATE_FILE_NAME}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDateString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DATE_PATTERN.test(value));
}

function isInstantString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Validates and canonicalises parsed JSON. Unknown fields are deliberately
 * DROPPED during reconstruction, so a future version's extra keys survive a
 * schemaVersion-1 write only until the first re-save; reads stay exactly the
 * declared nine-field shape.
 */
function toAlertState(raw: unknown): AlertState | null {
  if (!isRecord(raw) || raw.schemaVersion !== ALERT_STATE_SCHEMA_VERSION) {
    return null;
  }
  const {
    lastState,
    firstAlertDate,
    lastAlertDate,
    lastRecoveryDate,
    lastCheckAt,
    lastAttemptAt,
    lastSentAt,
    lastError,
  } = raw;
  if (typeof lastState !== "string" || !TRACKED_STATES.includes(lastState as AlertTrackedState)) {
    return null;
  }
  if (
    !isDateString(firstAlertDate) ||
    !isDateString(lastAlertDate) ||
    !isDateString(lastRecoveryDate) ||
    !isInstantString(lastCheckAt) ||
    !isInstantString(lastAttemptAt) ||
    !isInstantString(lastSentAt) ||
    !(lastError === null || typeof lastError === "string")
  ) {
    return null;
  }
  return {
    schemaVersion: ALERT_STATE_SCHEMA_VERSION,
    lastState: lastState as AlertTrackedState,
    firstAlertDate,
    lastAlertDate,
    lastRecoveryDate,
    lastCheckAt,
    lastAttemptAt,
    lastSentAt,
    lastError,
  };
}

/** Missing file => null. Corrupt JSON / wrong shape => state-corrupt log + null. */
export async function readAlertState(file: string): Promise<AlertState | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    console.log(
      JSON.stringify({ evt: "state-corrupt", file, reason: "unreadable", error: String(error) }),
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(JSON.stringify({ evt: "state-corrupt", file, reason: "invalid-json" }));
    return null;
  }
  const state = toAlertState(parsed);
  if (state === null) {
    console.log(JSON.stringify({ evt: "state-corrupt", file, reason: "unsupported-shape" }));
  }
  return state;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export async function writeAlertState(file: string, state: AlertState): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export function baselineState(now: Date): AlertState {
  return {
    schemaVersion: ALERT_STATE_SCHEMA_VERSION,
    lastState: "baseline",
    firstAlertDate: null,
    lastAlertDate: null,
    lastRecoveryDate: null,
    lastCheckAt: toStateInstant(now),
    lastAttemptAt: null,
    lastSentAt: null,
    lastError: null,
  };
}

/** skip path: refresh the check stamp and tracked level, nothing else. */
export function checkedState(
  prev: AlertState,
  now: Date,
  tracked: AlertTrackedState,
): AlertState {
  return { ...prev, lastState: tracked, lastCheckAt: toStateInstant(now) };
}

/**
 * Dry-run touch: refresh check/attempt stamps but keep every cadence date and
 * lastState untouched, so switching to live still sends a first alert today.
 */
export function touchedState(prev: AlertState, now: Date): AlertState {
  const instant = toStateInstant(now);
  return { ...prev, lastCheckAt: instant, lastAttemptAt: instant };
}

export function intentStateFor(
  prev: AlertState,
  kind: AlertIntentKind,
  today: string,
  now: Date,
): AlertState {
  const attempt = toStateInstant(now);
  if (kind === "send-first") {
    return {
      ...prev,
      lastState: "stale",
      firstAlertDate: prev.firstAlertDate ?? today,
      lastAlertDate: today,
      lastAttemptAt: attempt,
    };
  }
  if (kind === "send-repeat") {
    return {
      ...prev,
      lastState: "stale",
      firstAlertDate: prev.firstAlertDate,
      lastAlertDate: today,
      lastAttemptAt: attempt,
    };
  }
  return {
    ...prev,
    lastState: "ok",
    lastRecoveryDate: today,
    lastAttemptAt: attempt,
  };
}

export function sentState(intent: AlertState, now: Date): AlertState {
  return { ...intent, lastSentAt: toStateInstant(now), lastError: null };
}

/** The failure records the reason but moves NO date fields (same-day suppression). */
export function failedState(intent: AlertState, sanitizedError: string): AlertState {
  return { ...intent, lastError: sanitizedError };
}
