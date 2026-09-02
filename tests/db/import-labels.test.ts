// D-226 acceptance: the Chinese labels for the two import-log vocabularies.
//
// TypeScript already forces both maps to be exhaustive - they are declared as full
// Records over ImportStatus / ImportTrigger. What the compiler cannot catch is two members
// sharing one label, and that is the failure that matters here: /admin/audit exists so an
// operator can tell a 定时 run from a 手工 upload, and a 成功 from a 失败. A duplicated
// word would render two different outcomes identically while every type check stays green.

import { describe, expect, it } from "vitest";

import { IMPORT_STATUS_LABELS, IMPORT_TRIGGER_LABELS } from "@/lib/db/import-labels";
import { IMPORT_STATUSES, IMPORT_TRIGGERS } from "@/lib/db/import-status";

describe("IMPORT_STATUS_LABELS", () => {
  it("labels every status in the vocabulary", () => {
    for (const status of IMPORT_STATUSES) {
      expect(IMPORT_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("carries no key outside the vocabulary", () => {
    // A leftover key from a renamed status is dead weight that still reads as supported.
    expect(Object.keys(IMPORT_STATUS_LABELS).sort()).toEqual([...IMPORT_STATUSES].sort());
  });

  it("gives each status a distinct label", () => {
    const labels = IMPORT_STATUSES.map((status) => IMPORT_STATUS_LABELS[status]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("IMPORT_TRIGGER_LABELS", () => {
  it("labels every trigger in the vocabulary", () => {
    for (const trigger of IMPORT_TRIGGERS) {
      expect(IMPORT_TRIGGER_LABELS[trigger]).toBeTruthy();
    }
  });

  it("carries no key outside the vocabulary", () => {
    expect(Object.keys(IMPORT_TRIGGER_LABELS).sort()).toEqual([...IMPORT_TRIGGERS].sort());
  });

  it("gives each trigger a distinct label", () => {
    // The whole reason 问题 1 was reportable: "the system did not fetch this by itself" is
    // only visible if 定时 and 手工 are different words on screen.
    const labels = IMPORT_TRIGGERS.map((trigger) => IMPORT_TRIGGER_LABELS[trigger]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
