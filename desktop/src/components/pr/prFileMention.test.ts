import { describe, expect, test } from "bun:test";

import { fileMentionText, rankFileMentions } from "./PrFileMentionPicker";

const FILES = [
  "src/lib/api.ts",
  "src/components/pr/PrDiffBody.tsx",
  "src/components/pr/PrChecksTab.tsx",
  "docs/checks.md",
];

describe("rankFileMentions", () => {
  test("no query lists the PR's files in order, capped", () => {
    expect(rankFileMentions(FILES, "")).toEqual(FILES);
    expect(rankFileMentions(FILES, "  ", 2)).toEqual(FILES.slice(0, 2));
  });

  test("basename hits outrank path-only hits", () => {
    // "checks" is in the basename of two files and only in the path of none.
    expect(rankFileMentions(FILES, "checks")).toEqual([
      "src/components/pr/PrChecksTab.tsx",
      "docs/checks.md",
    ]);
    // "pr" is a basename hit for the two Pr* files and a path hit for none
    // besides them; "components" is path-only.
    expect(rankFileMentions(FILES, "components")).toEqual([
      "src/components/pr/PrDiffBody.tsx",
      "src/components/pr/PrChecksTab.tsx",
    ]);
  });

  test("matching is case-insensitive and unmatched is empty", () => {
    expect(rankFileMentions(FILES, "API")).toEqual(["src/lib/api.ts"]);
    expect(rankFileMentions(FILES, "zzz")).toEqual([]);
  });
});

describe("fileMentionText", () => {
  test("wraps the path in backticks with a trailing space", () => {
    expect(fileMentionText("src/lib/api.ts")).toBe("`src/lib/api.ts` ");
  });
});
