// Whether the account of a change is still about the change in front of you.
//
//   bun test ./tests/changeExplainCache.test.ts
//
// AURA-1361. The held entry was keyed by (repo, file, commit). A working-tree
// edit has no commit, so every edit of a file shared one key: the FIRST account
// of it was pinned and served forever. Edit the file after reading its
// explanation, come back, and you read a description of code you had already
// changed — with no sign that anything was stale.
//
// A commit's diff cannot change, so holding that one is both safe and the
// reason the surface paints instantly on a re-open. The split is the fix.

import { describe, expect, test, mock, beforeEach } from "bun:test";

let calls: string[] = [];
let answer = "first account";

mock.module("../src/lib/api", () => ({
  api: {
    explainChange: async (_repo: string, file: string, commit?: string) => {
      calls.push(`${file}@${commit ?? "worktree"}`);
      return {
        before: "",
        what: answer,
        why: "",
        why_source: "model",
        source: "model",
        diff_hash: answer,
      };
    },
    explainSymbols: async () => [],
  },
}));

const { loadExplanation, forgetExplanation } = await import("../src/lib/changeExplain");

beforeEach(() => {
  calls = [];
  answer = "first account";
  forgetExplanation("/repo", "src/lib.rs");
  forgetExplanation("/repo", "src/lib.rs", "abc1234");
});

describe("a working-tree edit", () => {
  test("is re-read on a revisit, so the words follow the diff", async () => {
    const first = await loadExplanation("/repo", "src/lib.rs");
    expect(first.what).toBe("first account");

    // The reader edits the file and comes back to it.
    answer = "second account";
    const second = await loadExplanation("/repo", "src/lib.rs");

    expect(second.what).toBe("second account");
    expect(calls).toEqual(["src/lib.rs@worktree", "src/lib.rs@worktree"]);
  });

  test("still shares one request between two panes asking at once", async () => {
    // Correctness must not cost the in-flight dedupe: opening the same change
    // in two places in the same tick is one call, not two.
    const [a, b] = await Promise.all([
      loadExplanation("/repo", "src/lib.rs"),
      loadExplanation("/repo", "src/lib.rs"),
    ]);
    expect(a.what).toBe("first account");
    expect(b.what).toBe("first account");
    expect(calls).toHaveLength(1);
  });
});

describe("a committed change", () => {
  test("is asked for once, because its diff can never change", async () => {
    await loadExplanation("/repo", "src/lib.rs", "abc1234");
    answer = "a different account";
    const again = await loadExplanation("/repo", "src/lib.rs", "abc1234");

    expect(again.what).toBe("first account");
    expect(calls).toEqual(["src/lib.rs@abc1234"]);
  });

  test("is not confused with the working-tree edit of the same file", async () => {
    await loadExplanation("/repo", "src/lib.rs", "abc1234");
    answer = "the uncommitted edit";
    const dirty = await loadExplanation("/repo", "src/lib.rs");

    expect(dirty.what).toBe("the uncommitted edit");
    expect(calls).toEqual(["src/lib.rs@abc1234", "src/lib.rs@worktree"]);
  });

  test("can be re-asked deliberately, which is what retry does", async () => {
    await loadExplanation("/repo", "src/lib.rs", "abc1234");
    forgetExplanation("/repo", "src/lib.rs", "abc1234");
    answer = "second try";
    const retried = await loadExplanation("/repo", "src/lib.rs", "abc1234");

    expect(retried.what).toBe("second try");
    expect(calls).toHaveLength(2);
  });
});
