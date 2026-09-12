import { describe, expect, it } from "vitest";

import { exitCodeFor } from "@/lib/alerts/alert-service";

describe("exitCodeFor", () => {
  it.each([
    ["a healthy skip", undefined, 0],
    ["a baseline grace scan", undefined, 0],
    ["a dry-run delivery", undefined, 0],
    ["a successful live send", undefined, 0],
    ["config-error", "config-error", 1],
    ["a live send failure", "send-failed", 1],
    ["a database read failure", "db-read-failed", 2],
    ["a state write failure", "state-write-failed", 2],
  ] as const)("maps %s to exit code %i", (_label, code, expected) => {
    expect(exitCodeFor(code ?? undefined)).toBe(expected);
  });
});
