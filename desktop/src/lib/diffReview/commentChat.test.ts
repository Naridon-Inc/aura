// What these pin: a comment lands in a mounted composer as a markdown file
// whose name stays the same, so the composer's list says it is there and it
// can be taken back out; with no composer mounted nothing claims success; and
// the last composer to come up is the one a diff hands comments to.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { registerComposerAttacher } from "../composerAttachments";
import {
  addCommentToChat,
  commentChatTarget,
  commentFileName,
  commentMarkdown,
  isCommentInComposer,
  markSentComments,
  removeCommentFromChat,
} from "./commentChat";
import { listComments, resetCommentCache, upsertComments, type ReviewComment } from "./reviewComments";

const comment: ReviewComment = {
  id: "cabc123xyz789",
  workspace: "/repo",
  filePath: "src/net/retry.ts",
  lineNumber: 12,
  endLineNumber: 15,
  side: "additions",
  body: "Back off exponentially here.\n",
  state: "ready_for_review",
  createdAt: 0,
  suggestionBaseCode: "await sleep(100);",
};

function fakeComposer() {
  const files: File[] = [];
  return {
    files,
    attacher: {
      attach: (f: File) => void files.push(f),
      names: () => files.map((f) => f.name),
      remove: (name: string) => {
        const i = files.findIndex((f) => f.name === name);
        if (i >= 0) files.splice(i, 1);
      },
    },
  };
}

describe("comment to chat", () => {
  it("names the file after the file, the lines and the comment", () => {
    expect(commentFileName(comment)).toBe("review-retry.ts-L12-15-xyz789.md");
    expect(commentFileName({ ...comment, endLineNumber: undefined })).toBe("review-retry.ts-L12-xyz789.md");
  });

  it("writes where the comment sits, the lines and the body", () => {
    const md = commentMarkdown(comment);
    expect(md).toContain("`src/net/retry.ts` — Lines 12–15, in the new version.");
    expect(md).toContain("```\nawait sleep(100);\n```");
    expect(md).toContain("Back off exponentially here.");
    expect(commentMarkdown({ ...comment, side: "deletions", endLineNumber: undefined })).toContain(
      "Line 12, in the old version (removed lines).",
    );
  });

  it("lands in the composer once and comes back out", async () => {
    const c = fakeComposer();
    const off = registerComposerAttacher("s-1", c.attacher);
    expect(addCommentToChat("s-1", comment)).toBe(true);
    expect(addCommentToChat("s-1", comment)).toBe(true);
    expect(c.files).toHaveLength(1);
    expect(c.files[0].type).toBe("text/markdown");
    expect(await c.files[0].text()).toContain("Back off exponentially here.");
    expect(isCommentInComposer("s-1", comment)).toBe(true);
    expect(removeCommentFromChat("s-1", comment)).toBe(true);
    expect(isCommentInComposer("s-1", comment)).toBe(false);
    off();
  });

  it("claims nothing with no composer mounted", () => {
    expect(addCommentToChat("nobody", comment)).toBe(false);
    expect(removeCommentFromChat("nobody", comment)).toBe(false);
  });

  it("hands comments to the composer that came up last", () => {
    const a = fakeComposer();
    const b = fakeComposer();
    const offA = registerComposerAttacher("s-a", a.attacher);
    const offB = registerComposerAttacher("s-b", b.attacher);
    expect(commentChatTarget()).toBe("s-b");
    offB();
    expect(commentChatTarget()).toBe("s-a");
    offA();
    expect(commentChatTarget()).toBeNull();
  });
});

describe("sent comments", () => {
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

  it("a message carrying a comment's file takes it off the diff", () => {
    const other = { ...comment, id: "cother000111222", lineNumber: 30, endLineNumber: undefined };
    upsertComments("/repo", [comment, other]);
    expect(listComments("/repo", comment.filePath)).toHaveLength(2);
    expect(markSentComments(["notes.txt", commentFileName(comment), undefined, null])).toBe(1);
    const left = listComments("/repo", comment.filePath);
    expect(left.map((c) => c.id)).toEqual([other.id]);
    expect(listComments("/repo").find((c) => c.id === comment.id)?.state).toBe("reviewed");
  });

  it("a message with no review files changes nothing", () => {
    upsertComments("/repo", [comment]);
    expect(markSentComments(["image.png", "readme.md"])).toBe(0);
    expect(listComments("/repo", comment.filePath)).toHaveLength(1);
  });
});
