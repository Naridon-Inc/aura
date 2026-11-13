import { describe, expect, it } from "bun:test";
import { claimsDoneButNot, partsSentence, requirementTitle, splitPath } from "./goalStoryText";

describe("goal story words", () => {
  it("flags a task marked done that the code doesn't back up", () => {
    expect(claimsDoneButNot("done", "partial")).toBe(true);
    expect(claimsDoneButNot("done", "not_wired")).toBe(true);
    expect(claimsDoneButNot("done", "verified")).toBe(false);
    expect(claimsDoneButNot("done", "unknown")).toBe(false);
    expect(claimsDoneButNot("in_progress", "partial")).toBe(false);
  });

  it("names a part in words, keeping one that already is words", () => {
    expect(requirementTitle({ nodeName: "saveThemePref", nodeType: "function", mustCall: null })).toBe("Save theme pref");
    expect(requirementTitle({ nodeName: "Sign in works", nodeType: "flow", mustCall: null })).toBe("Sign in works");
  });

  it("counts the parts in place in a sentence", () => {
    expect(partsSentence(0, 0)).toBeNull();
    expect(partsSentence(4, 4)).toBe("All 4 parts it needs are in place.");
    expect(partsSentence(1, 1)).toBe("The one part it needs is in place.");
    expect(partsSentence(0, 3)).toBe("None of the 3 parts it needs are in place yet.");
    expect(partsSentence(2, 1200)).toBe("2 of the 1,200 parts it needs are in place.");
  });

  it("splits a file into its name and folder", () => {
    expect(splitPath("src/lib/auth.ts")).toEqual({ name: "auth.ts", folder: "src/lib" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", folder: "the repository's top folder" });
  });
});
