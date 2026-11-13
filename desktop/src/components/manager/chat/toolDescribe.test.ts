// What these pin: an agent's review comments read in the chat as "Code
// review comments" with how many it left and where each sits, and its read of
// them as "Review comments" on one file or all of them.

import { describe, expect, it } from "bun:test";

import { describeTool } from "./toolDescribe";

describe("review comment tools", () => {
  it("names the comments left and where each sits", () => {
    const v = describeTool("mcp__aura-vcs__aura_review_comment_add", {
      comments: [
        { file: "src/x.ts", line: 4, body: "Check the bounds." },
        { file: "src/y.ts", line: 9, body: "Dead code." },
      ],
    });
    expect(v.verb).toBe("Code review comments");
    expect(v.metric).toBe("2 comments");
    expect(v.fields).toEqual([
      { label: "src/x.ts:4", value: "Check the bounds." },
      { label: "src/y.ts:9", value: "Dead code." },
    ]);
    expect(v.hideRawInput).toBe(true);
    expect(describeTool("aura_review_comment_add", { comments: [{ file: "a", line: 1, body: "b" }] }).metric).toBe(
      "1 comment",
    );
  });

  it("reads one file's comments or every file's", () => {
    expect(describeTool("mcp__aura-vcs__aura_review_comments_list", { file: "src/net/retry.ts" }).subject).toBe(
      "retry.ts",
    );
    const all = describeTool("aura_review_comments_list", {});
    expect(all.verb).toBe("Review comments");
    expect(all.subject).toBe("All files");
  });
});
