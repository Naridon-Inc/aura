// What a past session is called in a list, given that a lot of "prompts" were
// never typed by anyone.
//
// The failure mode is specific: every wrapper the runtime writes is identical
// across sessions, so a row that falls through to the raw text stops telling
// the reader which session they are looking at. These pin the wrappers that
// are worth naming, and the prose that must still come through untouched.

import { describe, expect, test } from "bun:test";

import { sessionPromptTitle } from "./sessionPromptTitle";

describe("naming a past session", () => {
  test("a typed prompt is the title", () => {
    expect(sessionPromptTitle("fix the retry in cloud_auth.rs")).toBe(
      "fix the retry in cloud_auth.rs",
    );
  });

  // The one every compacted session shares. Left to fall through it reads
  // "This session is being continued from a previous conversation…" on every
  // row that has ever run long, which is the opposite of a name.
  test("a compaction handoff is named as one, not quoted", () => {
    const handoff = [
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
      "",
      "Summary:",
      "1. Primary Request and Intent",
    ].join("\n");
    expect(sessionPromptTitle(handoff)).toBe("↻ continued after compaction");
  });

  test("a scheduled fire is named by its summary", () => {
    expect(
      sessionPromptTitle(
        "<task-notification><summary>nightly deploy check</summary></task-notification>",
      ),
    ).toBe("↻ scheduled · nightly deploy check");
  });

  test("a slash command keeps the command", () => {
    expect(sessionPromptTitle("<command-name>review</command-name>")).toBe("/ review");
  });

  test("nothing to say stays empty, for the caller to word", () => {
    expect(sessionPromptTitle("")).toBe("");
    expect(sessionPromptTitle(null)).toBe("");
    expect(sessionPromptTitle("   ")).toBe("");
  });
});
