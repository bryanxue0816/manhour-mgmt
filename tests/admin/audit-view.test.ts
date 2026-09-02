import { describe, expect, it } from "vitest";

import {
  parseAuditTab,
  parsePageNumber,
} from "@/app/admin/audit/_components/AuditNav";
import {
  prettyPrintSnapshot,
  summariseSnapshot,
} from "@/app/admin/audit/snapshot-summary";

const UNREADABLE = "（快照无法解析）";

describe("summariseSnapshot", () => {
  it("summarises an organisation snapshot", () => {
    const raw = JSON.stringify({
      departments: [{ name: "制造部" }, { name: "经营企画部" }],
      sections: [{ name: "検査课" }],
    });

    expect(summariseSnapshot(raw)).toBe("部 2 · 课 1");
  });

  it("summarises a job-title-rule snapshot", () => {
    const raw = JSON.stringify({ rules: [{}, {}, {}] });

    expect(summariseSnapshot(raw)).toBe("职位规则 3 条");
  });

  it("reports zero-length collections rather than omitting them", () => {
    // An empty array is a real state - a snapshot taken when nothing existed yet - and
    // is not the same claim as "this key was absent".
    expect(summariseSnapshot(JSON.stringify({ departments: [], sections: [] }))).toBe(
      "部 0 · 课 0",
    );
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a bare string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
    ["an object with no known keys", '{"somethingElse":1}'],
    ["a known key holding a non-array", '{"departments":7}'],
  ])("returns a readable placeholder for %s instead of throwing", (_label, raw) => {
    // The whole point of this module not throwing: a page that 500s because one of
    // forty rows is malformed hides the other thirty-nine.
    expect(summariseSnapshot(raw)).toBe(UNREADABLE);
  });
});

describe("prettyPrintSnapshot", () => {
  it("re-indents stored compact JSON", () => {
    expect(prettyPrintSnapshot('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("returns unparseable input untouched", () => {
    // Offering a raw view and then hiding the raw bytes would defeat its purpose.
    expect(prettyPrintSnapshot("{not json")).toBe("{not json");
  });
});

describe("parseAuditTab", () => {
  it.each([
    ["plan", "plan"],
    ["master", "master"],
    ["import", "import"],
  ])("reads the %s tab", (raw, expected) => {
    // plan is asserted explicitly too: it is also the fallback, so without this case a
    // typo in its own branch would still pass every test below.
    expect(parseAuditTab(raw)).toBe(expected);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["unrecognised", "nonsense"],
    ["wrong case", "Master"],
    ["wrong case on the import tab", "Import"],
  ])("falls back to the plan tab when %s", (_label, raw) => {
    expect(parseAuditTab(raw)).toBe("plan");
  });
});

describe("parsePageNumber", () => {
  it("reads a valid page", () => {
    expect(parsePageNumber("3")).toBe(3);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-3"],
    ["non-numeric", "abc"],
  ])("clamps to page 1 when %s", (_label, raw) => {
    // Clamping rather than erroring: a stale bookmark should land on a working page.
    expect(parsePageNumber(raw)).toBe(1);
  });

  it("takes the leading integer of a decimal", () => {
    expect(parsePageNumber("2.9")).toBe(2);
  });
});
