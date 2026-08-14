// renameSection(): the boundary between the browser and renameSectionWithAlias().
//
// A Server Action is a public HTTP endpoint, so this layer owns two guarantees that the
// repository deliberately does not:
//
//   1. It VALIDATES the raw payload. `nameRaw` arrives as whatever was posted, which is
//      not necessarily a string at all.
//
//   2. It RETURNS failures instead of throwing them. A thrown Server Action reaches the
//      client as an opaque digest in production, which would turn a correctable
//      "本部门下已有..." into "something went wrong" - and an operator who cannot read
//      the reason retries, which is exactly the wrong response to a refused rename.
//
// The load-bearing assertion in every rejection case is NOT the message - it is that
// renameSectionWithAlias was NEVER CALLED. The messages can be reworded; a rejected
// input that still reaches the write is a defect regardless of what it renders.
//
// Why the repository module is only PARTIALLY mocked: `SectionRenameError` is matched
// with `instanceof`, so the test has to hand the action the real class. A hand-rolled
// stand-in would satisfy the test while drifting from the class the action actually
// checks against - the failure mode being that every refusal silently falls through to
// the generic backstop message. `@/lib/prisma` is mocked to a bare object so that
// importing the real repository module never builds a better-sqlite3 client.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renameSectionWithAlias: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/db/org.repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/org.repo")>()),
  renameSectionWithAlias: mocks.renameSectionWithAlias,
}));

import { Prisma } from "@/generated/prisma/client";
import { renameSection, type RenameSectionInput } from "@/app/admin/actions";
import { SectionRenameError } from "@/lib/db/org.repo";

const SECTION_ID = "sec-kensa";

function input(overrides: Partial<RenameSectionInput> = {}): RenameSectionInput {
  return { id: SECTION_ID, nameRaw: "検査品证课", ...overrides };
}

/** A refusal from the repository, as the action will see it. */
function refuse(reason: ConstructorParameters<typeof SectionRenameError>[0]): void {
  mocks.renameSectionWithAlias.mockRejectedValue(new SectionRenameError(reason, "refused"));
}

beforeEach(() => {
  // restoreMocks does not clear a hoisted bare vi.fn(), so the not.toHaveBeenCalled()
  // assertions below would pass or fail depending on test ORDER without this.
  mocks.renameSectionWithAlias.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.renameSectionWithAlias.mockResolvedValue({
    id: SECTION_ID,
    departmentId: "dep-q",
    name: "検査品证课",
    sortOrder: 18,
    managerName: null,
    managerEmail: null,
  });
});

describe("renameSection - accepts a valid rename", () => {
  it("passes the TRIMMED name through and revalidates", async () => {
    const result = await renameSection(input({ nameRaw: "  検査品证课  " }));

    expect(result).toEqual({ ok: true });
    // Trimmed at this layer, not the repository: alias keys are compared verbatim, so a
    // stored "検査品证课 " would never match anything typed by hand again.
    expect(mocks.renameSectionWithAlias).toHaveBeenCalledWith(SECTION_ID, "検査品证课");
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("accepts a name at exactly the 50-character limit", async () => {
    const atLimit = "课".repeat(50);

    const result = await renameSection(input({ nameRaw: atLimit }));

    expect(result.ok).toBe(true);
    expect(mocks.renameSectionWithAlias).toHaveBeenCalledWith(SECTION_ID, atLimit);
  });
});

describe("renameSection - rejects a malformed payload without writing", () => {
  it.each([
    ["an empty name", { nameRaw: "" }],
    ["a whitespace-only name", { nameRaw: "   " }],
    ["a name over 50 characters", { nameRaw: "课".repeat(51) }],
    ["a non-string name", { nameRaw: 42 as unknown as string }],
    ["a null name", { nameRaw: null as unknown as string }],
  ])("refuses %s", async (_label, overrides) => {
    const result = await renameSection(input(overrides));

    expect(result.ok).toBe(false);
    expect(mocks.renameSectionWithAlias).not.toHaveBeenCalled();
    if (!result.ok) {
      // Reported against the field so the editor can mark that one input red.
      expect(result.fieldErrors.name).toBeTruthy();
    }
  });

  it.each([
    ["a missing id", { id: undefined as unknown as string }],
    ["a blank id", { id: "   " }],
    ["a non-string id", { id: 7 as unknown as string }],
  ])("refuses %s", async (_label, overrides) => {
    const result = await renameSection(input(overrides));

    expect(result.ok).toBe(false);
    expect(mocks.renameSectionWithAlias).not.toHaveBeenCalled();
    if (!result.ok) {
      // No field to mark: the id is not something the operator typed, so the message
      // has to tell them what to DO instead - reload.
      expect(result.fieldErrors).toEqual({});
      expect(result.message).toContain("刷新");
    }
  });

  it("refuses a missing payload entirely", async () => {
    const result = await renameSection(undefined as unknown as RenameSectionInput);

    expect(result.ok).toBe(false);
    expect(mocks.renameSectionWithAlias).not.toHaveBeenCalled();
  });

  it("does not revalidate when the input is refused", async () => {
    await renameSection(input({ nameRaw: "" }));

    // Revalidating on a no-write would re-render the page as if something changed,
    // which is how a rejected rename comes to look like an applied one.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("renameSection - turns every repository refusal into a readable failure", () => {
  it("reports a vanished section as needing a reload", async () => {
    refuse("not-found");

    const result = await renameSection(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("刷新");
      expect(result.fieldErrors).toEqual({});
    }
  });

  it("names the occupying section for a taken name", async () => {
    refuse("name-taken");

    const result = await renameSection(input({ nameRaw: "品证课" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The rejected value is quoted back: "already taken" without saying WHICH name
      // is useless in a tree of 24 sections.
      expect(result.fieldErrors.name).toContain("品证课");
    }
  });

  it("explains an alias conflict as a mapping that must be handled first", async () => {
    refuse("alias-conflict");

    const result = await renameSection(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toContain("别名");
    }
  });

  it("explains an alias shadow as absorbing another section's history", async () => {
    refuse("alias-shadow");

    const result = await renameSection(input({ nameRaw: "検查课" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toContain("検查课");
      expect(result.fieldErrors.name).toContain("历史考勤");
    }
  });

  it.each([
    ["not-found" as const],
    ["name-taken" as const],
    ["alias-conflict" as const],
    ["alias-shadow" as const],
  ])("does not revalidate after a %s refusal", async (reason) => {
    refuse(reason);

    await renameSection(input());

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("renameSection - backstops the race the repository cannot close", () => {
  /** A constraint violation, which is how a concurrent write arrives instead. */
  function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError("constraint", {
      code,
      clientVersion: "test",
    });
  }

  it("maps P2002 to the same taken-name message", async () => {
    // The repository checks for a clash and then writes; another transaction can commit
    // in between. Without this branch that window surfaces as raw English SQL text.
    mocks.renameSectionWithAlias.mockRejectedValue(knownRequestError("P2002"));

    const result = await renameSection(input({ nameRaw: "品证课" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toContain("品证课");
    }
  });

  it("maps P2025 to the same reload message", async () => {
    mocks.renameSectionWithAlias.mockRejectedValue(knownRequestError("P2025"));

    const result = await renameSection(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("刷新");
    }
  });

  it("reports an unexpected failure as nothing-was-written", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.renameSectionWithAlias.mockRejectedValue(new Error("socket hang up"));

    const result = await renameSection(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // "数据未写入" is the part that matters: it tells the operator retrying is safe.
      expect(result.message).toContain("数据未写入");
      expect(result.message).not.toContain("socket hang up");
    }
    // Still logged server-side - the operator gets a safe message, the administrator
    // gets the cause.
    expect(consoleError).toHaveBeenCalled();
  });
});
