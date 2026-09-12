// Run with: bun test src/components/manager/chat/chatPlace.test.ts
//
// AURA-264: the sidebar and the status bar both said `zagreb`; Home said "a
// copy of managua" — a worktree that had been deleted. Home is where agent
// work is launched from, so the reader was told the wrong place for the edits
// they were about to ask for.

import { describe, expect, test } from "bun:test";

import { chatPlace, chatPlaceSentence, folderName } from "./chatPlace";

const ZAGREB = "/Users/me/.aura/worktrees/p-abc/zagreb";
const MANAGUA = "/Users/me/.aura/worktrees/p-abc/managua";

describe("chatPlace", () => {
  test("a chat running where you are standing has nothing to say", () => {
    expect(chatPlace(ZAGREB, ZAGREB, true)).toEqual({ kind: "same" });
  });

  test("a trailing slash is not a different place", () => {
    expect(chatPlace(ZAGREB + "/", ZAGREB, true)).toEqual({ kind: "same" });
  });

  test("a chat bound elsewhere says so", () => {
    // Legitimate — a conversation about one repo must not follow you into
    // another — but the reader has to know before they send a prompt.
    expect(chatPlace(MANAGUA, ZAGREB, true)).toEqual({
      kind: "elsewhere",
      runsIn: MANAGUA,
    });
  });

  test("a folder that is gone outranks any disagreement", () => {
    // This is the reported case: the named worktree no longer existed.
    expect(chatPlace(MANAGUA, ZAGREB, false)).toEqual({
      kind: "missing",
      runsIn: MANAGUA,
    });
    expect(chatPlace(MANAGUA, MANAGUA, false)).toEqual({
      kind: "missing",
      runsIn: MANAGUA,
    });
  });

  test("a read that has not finished is never reported as missing", () => {
    // Claiming a folder is gone while still looking for it would be the same
    // false certainty the bug is about, pointed the other way.
    expect(chatPlace(MANAGUA, ZAGREB, null)).toEqual({
      kind: "elsewhere",
      runsIn: MANAGUA,
    });
    expect(chatPlace(ZAGREB, ZAGREB, null)).toEqual({ kind: "same" });
  });

  test("a chat with no project of its own follows the window", () => {
    expect(chatPlace(null, ZAGREB, true)).toEqual({ kind: "same" });
  });

  test("no workspace selected is not a disagreement", () => {
    expect(chatPlace(MANAGUA, null, true)).toEqual({ kind: "same" });
  });
});

describe("chatPlaceSentence", () => {
  test("says nothing when there is nothing to say", () => {
    expect(chatPlaceSentence({ kind: "same" })).toBeNull();
  });

  test("names the folder, not the path", () => {
    const s = chatPlaceSentence({ kind: "elsewhere", runsIn: MANAGUA });
    expect(s).toContain("managua");
    expect(s).not.toContain("/Users/");
  });

  test("a missing folder says what to do about it", () => {
    const s = chatPlaceSentence({ kind: "missing", runsIn: MANAGUA }) ?? "";
    expect(s).toContain("managua");
    expect(s.toLowerCase()).toContain("new chat");
  });

  test("the copy stays plain — no worktree, no branch, no jargon", () => {
    const both = [
      chatPlaceSentence({ kind: "elsewhere", runsIn: MANAGUA }) ?? "",
      chatPlaceSentence({ kind: "missing", runsIn: MANAGUA }) ?? "",
    ].join(" ");
    for (const word of ["worktree", "repo root", "HEAD", "upstream"]) {
      expect(both.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe("folderName", () => {
  test("is the last segment", () => {
    expect(folderName(ZAGREB)).toBe("zagreb");
    expect(folderName(ZAGREB + "/")).toBe("zagreb");
  });

  test("survives a path with no segments", () => {
    expect(folderName("/")).toBe("/");
  });
});
