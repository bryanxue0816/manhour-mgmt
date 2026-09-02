// D-123 acceptance: the `import_log.status` / `import_log.triggeredBy` vocabulary.
//
// SQLite has no enum, so these two columns are plain TEXT and the only thing standing
// between them and a fourth silent state is the pair of asserts under test here. That is
// also why `lib/db/import-status.ts` exists as its own module: `import-log.repo.ts`
// constructs the Prisma client at import time, and a unit test must not need
// better-sqlite3 or DATABASE_URL to check a string comparison.
//
// The truncation suffix is written as escape sequences. `…` (U+2026) is a single
// character, not three dots, and `（已截断）` uses fullwidth parentheses - both are
// silently "fixable" by an editor in ways that would make the assertion pass against the
// wrong string.

import { describe, expect, it } from "vitest";

import {
  IMPORT_STATUSES,
  IMPORT_TRIGGERS,
  MAX_ERROR_MESSAGE_LENGTH,
  assertImportStatus,
  assertImportTrigger,
  completenessFieldsFor,
  normaliseErrorMessage,
  normaliseRatio,
} from "@/lib/db/import-status";

/** `…（已截断）` by codepoint - see the header note. */
const TRUNCATION_SUFFIX = String.fromCodePoint(0x2026, 0xff08, 0x5df2, 0x622a, 0x65ad, 0xff09);

describe("assertImportStatus", () => {
  it("accepts every declared status and returns it unchanged", () => {
    for (const status of IMPORT_STATUSES) {
      expect(assertImportStatus(status)).toBe(status);
    }
  });

  it("declares exactly the three statuses the schema documents", () => {
    expect([...IMPORT_STATUSES]).toEqual(["SUCCESS", "FAILED", "PARTIAL"]);
  });

  it("rejects a leading space - a padded value would split one status into two spellings", () => {
    expect(() => assertImportStatus(" SUCCESS")).toThrow();
  });

  it("rejects a lowercase spelling - WHERE status = 'SUCCESS' must not miss rows", () => {
    expect(() => assertImportStatus("success")).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => assertImportStatus("SKIPPED")).toThrow();
  });

  it("rejects the empty string", () => {
    expect(() => assertImportStatus("")).toThrow();
  });

  it("names the offending value and the allowed set, so a bad row is diagnosable", () => {
    let message = "";
    try {
      assertImportStatus("SKIPPED");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SKIPPED");
    for (const status of IMPORT_STATUSES) {
      expect(message).toContain(status);
    }
  });
});

describe("assertImportTrigger", () => {
  it("accepts every declared trigger and returns it unchanged", () => {
    for (const trigger of IMPORT_TRIGGERS) {
      expect(assertImportTrigger(trigger)).toBe(trigger);
    }
  });

  it("declares exactly the three triggers D-121 distinguishes", () => {
    expect([...IMPORT_TRIGGERS]).toEqual(["schedule", "manual", "retry"]);
  });

  it("rejects an uppercase spelling", () => {
    expect(() => assertImportTrigger("SCHEDULE")).toThrow();
  });

  it("rejects an unknown trigger", () => {
    expect(() => assertImportTrigger("cron")).toThrow();
  });
});

describe("normaliseErrorMessage", () => {
  it("maps null to null", () => {
    expect(normaliseErrorMessage(null)).toBeNull();
  });

  it("maps undefined to null", () => {
    expect(normaliseErrorMessage(undefined)).toBeNull();
  });

  it("maps the empty string to null - 'no error' must have one representation", () => {
    expect(normaliseErrorMessage("")).toBeNull();
  });

  it("maps a whitespace-only message to null", () => {
    expect(normaliseErrorMessage("   \t\n  ")).toBeNull();
  });

  it("trims a real message rather than dropping it", () => {
    expect(normaliseErrorMessage("  parse failed  ")).toBe("parse failed");
  });

  it("keeps a message of exactly the limit intact", () => {
    const exact = "x".repeat(MAX_ERROR_MESSAGE_LENGTH);
    expect(normaliseErrorMessage(exact)).toBe(exact);
  });

  it("truncates one character past the limit and marks it", () => {
    const tooLong = "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 1);
    const result = normaliseErrorMessage(tooLong);
    expect(result).toBe(`${"x".repeat(MAX_ERROR_MESSAGE_LENGTH)}${TRUNCATION_SUFFIX}`);
    // The marker is what tells a reader the stack trace is incomplete; without it a
    // truncated message reads like the whole error.
    expect(result?.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("truncates a very long message to the limit plus the marker", () => {
    const result = normaliseErrorMessage("y".repeat(50_000));
    expect(result).not.toBeNull();
    expect(result?.length).toBe(MAX_ERROR_MESSAGE_LENGTH + TRUNCATION_SUFFIX.length);
  });

  it("trims before measuring, so padding alone cannot trigger truncation", () => {
    const padded = `   ${"z".repeat(MAX_ERROR_MESSAGE_LENGTH)}   `;
    expect(normaliseErrorMessage(padded)).toBe("z".repeat(MAX_ERROR_MESSAGE_LENGTH));
  });
});

describe("normaliseRatio", () => {
  it("maps null and undefined to null", () => {
    expect(normaliseRatio(null)).toBeNull();
    expect(normaliseRatio(undefined)).toBeNull();
  });

  it("keeps a measured ratio unchanged", () => {
    expect(normaliseRatio(0.297)).toBe(0.297);
  });

  it("keeps both ends of the range", () => {
    expect(normaliseRatio(0)).toBe(0);
    expect(normaliseRatio(1)).toBe(1);
  });

  it("maps NaN to null rather than storing it", () => {
    // 0/0 is the shape a rest-day file would produce upstream. A stored NaN survives every
    // comparison as false, so a later threshold re-derivation would read it as a healthy
    // day instead of as a missing measurement.
    expect(normaliseRatio(Number.NaN)).toBeNull();
  });

  it("maps Infinity to null", () => {
    expect(normaliseRatio(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normaliseRatio(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("clamps out-of-range values rather than dropping the measurement", () => {
    expect(normaliseRatio(1.4)).toBe(1);
    expect(normaliseRatio(-0.2)).toBe(0);
  });
});

describe("completenessFieldsFor (D-222)", () => {
  const measured = { warningMessage: "疑似导出过早", unexplainedZeroRatio: 0.3 };

  it("keeps both fields on SUCCESS", () => {
    expect(completenessFieldsFor("SUCCESS", measured)).toEqual({
      warningMessage: "疑似导出过早",
      unexplainedZeroRatio: 0.3,
    });
  });

  it("keeps both fields on PARTIAL - some rows landed, so the day is measurable", () => {
    expect(completenessFieldsFor("PARTIAL", measured)).toEqual({
      warningMessage: "疑似导出过早",
      unexplainedZeroRatio: 0.3,
    });
  });

  it("drops BOTH fields on FAILED", () => {
    // A failed import stores nothing, so a completeness warning would send the operator to
    // re-export a day that has no rows at all. And the ratio series is what will replace
    // the single-day threshold: a rolled-back file must not weight that calibration.
    expect(completenessFieldsFor("FAILED", measured)).toEqual({
      warningMessage: null,
      unexplainedZeroRatio: null,
    });
  });

  it("drops the ratio on FAILED even when the parse genuinely measured one", () => {
    // The real case: a clean file whose write then threw. The measurement is honest and
    // still must not be recorded, because the hours behind it were rolled back.
    expect(completenessFieldsFor("FAILED", { unexplainedZeroRatio: 0 })).toEqual({
      warningMessage: null,
      unexplainedZeroRatio: null,
    });
  });

  it("records a quiet day's ratio, not just a warned one", () => {
    // No warning fired, ratio still stored. That series is the whole plan for re-deriving
    // the 10% threshold from more than the single day it was set from.
    expect(completenessFieldsFor("SUCCESS", { unexplainedZeroRatio: 0.036 })).toEqual({
      warningMessage: null,
      unexplainedZeroRatio: 0.036,
    });
  });

  it("normalises through the same guards as a direct write", () => {
    expect(
      completenessFieldsFor("SUCCESS", { warningMessage: "   ", unexplainedZeroRatio: Number.NaN }),
    ).toEqual({ warningMessage: null, unexplainedZeroRatio: null });
  });
});
