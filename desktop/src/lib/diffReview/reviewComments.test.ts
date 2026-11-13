// What these pin: comments are kept per workspace and file and survive a
// reload from storage; picking a line twice does not stack two empty drafts;
// saving turns a draft into a comment; the editor's cancel asks first only
// when something would be lost; and a body's suggestion blocks split out with
// the code dedented the way the suggested-change box shows it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  COMMENTS_KEY,
  addDraft,
  anchorLine,
  cancelNeedsConfirm,
  commentCounts,
  commentKind,
  commentRangeLabel,
  dedent,
  deleteComment,
  discardDescription,
  discardDraft,
  getDraft,
  listComments,
  markReviewed,
  resetCommentCache,
  saveComment,
  splitSuggestions,
  startEdit,
  subscribeComments,
  shownOnDiff,
  updateDraftBody,
  upsertComments,
  workspacePath,
  type ReviewComment,
} from "./reviewComments";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  resetCommentCache();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  resetCommentCache();
});

const WS = "/repo/a";

describe("review comments", () => {
  it("opens a draft on a line and keeps it per workspace and file", () => {
    const c = addDraft({ workspace: WS, filePath: "src/x.ts", lineNumber: 4, side: "additions" });
    expect(c?.state).toBe("draft");
    expect(c?.body).toBe("");
    expect(listComments(WS, "src/x.ts")).toHaveLength(1);
    expect(listComments(WS, "src/y.ts")).toHaveLength(0);
    expect(listComments("/repo/b")).toHaveLength(0);
  });

  it("does not stack a second draft on the same run and side", () => {
    addDraft({ workspace: WS, filePath: "f", lineNumber: 2, endLineNumber: 5, side: "additions" });
    expect(addDraft({ workspace: WS, filePath: "f", lineNumber: 2, endLineNumber: 5, side: "additions" })).toBeNull();
    expect(addDraft({ workspace: WS, filePath: "f", lineNumber: 2, endLineNumber: 5, side: "deletions" })).not.toBeNull();
    expect(addDraft({ workspace: WS, filePath: "f", lineNumber: 2, side: "additions" })).not.toBeNull();
    expect(listComments(WS, "f")).toHaveLength(3);
  });

  it("a one-line run keeps no end line", () => {
    const c = addDraft({ workspace: WS, filePath: "f", lineNumber: 7, endLineNumber: 7, side: "additions" });
    expect(c?.endLineNumber).toBeUndefined();
    expect(anchorLine(c!)).toBe(7);
  });

  it("saving turns the draft into a comment, and it reads back from storage", () => {
    const c = addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" })!;
    saveComment(WS, c.id, "use a constant");
    resetCommentCache();
    const [back] = listComments(WS, "f");
    expect(back.state).toBe("ready_for_review");
    expect(back.body).toBe("use a constant");
    expect(JSON.parse(store.get(COMMENTS_KEY)!)[WS]).toHaveLength(1);
  });

  it("counts saved comments per file, drafts left out", () => {
    const a = addDraft({ workspace: WS, filePath: "a", lineNumber: 1, side: "additions" })!;
    saveComment(WS, a.id, "x");
    addDraft({ workspace: WS, filePath: "a", lineNumber: 9, side: "additions" });
    const b = addDraft({ workspace: WS, filePath: "b", lineNumber: 1, side: "deletions" })!;
    saveComment(WS, b.id, "y");
    expect(commentCounts(WS)).toEqual({ a: 1, b: 1 });
  });

  it("deleting the last comment drops the workspace's entry", () => {
    const c = addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" })!;
    deleteComment(WS, c.id);
    expect(listComments(WS)).toHaveLength(0);
    expect(JSON.parse(store.get(COMMENTS_KEY)!)).toEqual({});
  });

  it("hands back the same file list until something changes", () => {
    addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" });
    const first = listComments(WS, "f");
    expect(listComments(WS, "f")).toBe(first);
    addDraft({ workspace: WS, filePath: "f", lineNumber: 2, side: "additions" });
    expect(listComments(WS, "f")).not.toBe(first);
  });

  it("tells subscribers when the book changes", () => {
    let n = 0;
    const off = subscribeComments(() => n++);
    addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" });
    off();
    addDraft({ workspace: WS, filePath: "f", lineNumber: 3, side: "additions" });
    expect(n).toBe(1);
  });

  it("survives storage that is not an object", () => {
    store.set(COMMENTS_KEY, "[1,2]");
    resetCommentCache();
    expect(listComments(WS)).toHaveLength(0);
    store.set(COMMENTS_KEY, "{not json");
    resetCommentCache();
    expect(listComments(WS)).toHaveLength(0);
  });
});

function agentComment(id: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    workspace: WS,
    filePath: "src/x.ts",
    lineNumber: 3,
    side: "additions",
    body: "Check the bounds here.",
    state: "pending",
    createdAt: 1,
    author: "claude-sonnet",
    ...over,
  };
}

describe("comment states", () => {
  it("reads comments stored as saved as written by you", () => {
    store.set(
      COMMENTS_KEY,
      JSON.stringify({
        [WS]: [{ id: "old", workspace: WS, filePath: "f", lineNumber: 2, side: "additions", body: "b", state: "saved", createdAt: 5 }],
      }),
    );
    resetCommentCache();
    const [c] = listComments(WS, "f");
    expect(c.state).toBe("ready_for_review");
    expect(commentKind(c)).toBe("user-local");
  });

  it("saving dates a draft now and leaves an edit's date alone", () => {
    const c = addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" })!;
    const first = saveComment(WS, c.id, "one")!;
    expect(first.state).toBe("ready_for_review");
    expect(first.createdAt).toBeGreaterThanOrEqual(c.createdAt);
    upsertComments(WS, [{ ...first, createdAt: 7 }]);
    const edited = saveComment(WS, c.id, "two")!;
    expect(edited.createdAt).toBe(7);
    expect(edited.body).toBe("two");
  });

  it("an agent's comment is pending, has its author, and shows on the diff", () => {
    upsertComments(WS, [agentComment("r1-0")]);
    const [c] = listComments(WS, "src/x.ts");
    expect(c.state).toBe("pending");
    expect(commentKind(c)).toBe("agent-local");
    expect(commentCounts(WS)).toEqual({ "src/x.ts": 1 });
  });

  it("the diff leaves out reviewed comments and ones on no line", () => {
    expect(shownOnDiff({ lineNumber: 4, state: "pending" })).toBe(true);
    expect(shownOnDiff({ lineNumber: 4, state: "reviewed" })).toBe(false);
    expect(shownOnDiff({ lineNumber: 0, state: "pending" })).toBe(false);
    upsertComments(WS, [agentComment("r1-0"), agentComment("r1-1", { lineNumber: 0 })]);
    expect(listComments(WS, "src/x.ts").map((c) => c.id)).toEqual(["r1-0"]);
    expect(commentCounts(WS)).toEqual({ "src/x.ts": 1 });
  });

  it("arriving again refreshes a comment but never brings a reviewed one back", () => {
    upsertComments(WS, [agentComment("r1-0"), agentComment("r1-1", { lineNumber: 9 })]);
    upsertComments(WS, [agentComment("r1-0", { body: "Check the bounds and the sign." })]);
    expect(listComments(WS, "src/x.ts")).toHaveLength(2);
    expect(listComments(WS, "src/x.ts")[0].body).toBe("Check the bounds and the sign.");
    expect(markReviewed((c) => c.id === "r1-1")).toBe(1);
    upsertComments(WS, [agentComment("r1-1", { lineNumber: 9, body: "again" })]);
    const all = listComments(WS);
    expect(all.find((c) => c.id === "r1-1")?.state).toBe("reviewed");
    expect(all.find((c) => c.id === "r1-1")?.body).toBe("Check the bounds here.");
    expect(listComments(WS, "src/x.ts").map((c) => c.id)).toEqual(["r1-0"]);
  });

  it("marking reviewed skips drafts and reaches every workspace", () => {
    addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" });
    upsertComments("/repo/b", [agentComment("b-0", { workspace: "/repo/b" })]);
    expect(markReviewed(() => true)).toBe(1);
    expect(listComments(WS, "f")[0].state).toBe("draft");
    expect(listComments("/repo/b", "src/x.ts")).toHaveLength(0);
    expect(markReviewed(() => true)).toBe(0);
  });
});

describe("range label", () => {
  it("names a run of lines and nothing for one", () => {
    expect(commentRangeLabel({ lineNumber: 4, endLineNumber: 9 })).toBe("Lines 4–9");
    expect(commentRangeLabel({ lineNumber: 4 })).toBeNull();
    expect(commentRangeLabel({ lineNumber: 4, endLineNumber: 4 })).toBeNull();
  });
});

describe("edit drafts", () => {
  it("starting an edit keeps text already being written", () => {
    startEdit("k1", "saved");
    updateDraftBody("k1", "typing");
    startEdit("k1", "saved");
    expect(getDraft("k1")?.body).toBe("typing");
    discardDraft("k1");
    expect(getDraft("k1")).toBeUndefined();
  });

  it("asks before cancelling only when something would be lost", () => {
    expect(cancelNeedsConfirm({ editing: true, saved: "a", current: "a" })).toBe(false);
    expect(cancelNeedsConfirm({ editing: true, saved: "a", current: "ab" })).toBe(true);
    expect(cancelNeedsConfirm({ editing: false, saved: "", current: "  " })).toBe(false);
    expect(cancelNeedsConfirm({ editing: false, saved: "", current: "x" })).toBe(true);
    expect(discardDescription(true)).toBe("Your changes to this comment will be lost.");
    expect(discardDescription(false)).toBe("This comment will be lost.");
  });
});

describe("suggested changes", () => {
  it("splits a body around its suggestion blocks", () => {
    const parts = splitSuggestions("Try this:\n```suggestion\nconst n = 3;\n```\nthanks");
    expect(parts).toEqual([
      { kind: "text", text: "Try this:\n" },
      { kind: "suggestion", code: "const n = 3;" },
      { kind: "text", text: "\nthanks" },
    ]);
    expect(splitSuggestions("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });

  it("dedents code and trims blank edges", () => {
    expect(dedent("\n    a\n      b\n    c\n\n")).toBe("a\n  b\nc");
    expect(dedent("a\n b")).toBe("a\n b");
  });
});

describe("workspacePath", () => {
  it("keeps comments under the path relative to the workspace", () => {
    expect(workspacePath("/r/app", "/r/app/src/a.ts")).toBe("src/a.ts");
    expect(workspacePath("/r/app/", "/r/app/src/a.ts")).toBe("src/a.ts");
    expect(workspacePath("/r/app", "src/a.ts")).toBe("src/a.ts");
    expect(workspacePath("/r/app", "/r/application/a.ts")).toBe("/r/application/a.ts");
  });
});
