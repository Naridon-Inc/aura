// What these pin: the checkout key is the one Aura's MCP server computes, so
// both sides find the same folder; an agent's posted lines become pending
// comments under their lines, with the agent as author, and a broken or
// foreign line is skipped; reading the file again changes nothing; a comment
// sent back in chat stays reviewed when the file is read again; and the copy
// agents read carries your comments and their states, drafts left out.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  MIRROR_DELAY_MS,
  appCopy,
  commentsFolder,
  parseAgentComments,
  resetAgentComments,
  syncAgentComments,
  watchAgentComments,
  watchedCount,
  workspaceKey,
  writeAppCopy,
  type CommentFiles,
} from "./agentComments";
import {
  addDraft,
  listComments,
  markReviewed,
  resetCommentCache,
  saveComment,
  subscribeComments,
} from "./reviewComments";

const WS = "/repo/a";
const HOME = "/home/me";
const FOLDER = `${HOME}/.aura/review-comments/564ecae661f01822`;

let store: Map<string, string>;
let disk: Map<string, string>;
let dirs: string[];

function fakeDisk(): CommentFiles {
  return {
    home: async () => HOME,
    read: async (p) => disk.get(p) ?? null,
    write: async (p, t) => void disk.set(p, t),
    mkdir: async (p) => void dirs.push(p),
  };
}

function row(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "a1-0",
    workspace: WS,
    file: "src/x.ts",
    line: 4,
    side: "new",
    body: "Check the bounds.",
    author: "Claude Code",
    created_at: 1000,
    ...over,
  });
}

beforeEach(() => {
  store = new Map();
  disk = new Map();
  dirs = [];
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  resetCommentCache();
  resetAgentComments(fakeDisk());
});

afterEach(() => {
  resetAgentComments();
  delete (globalThis as { localStorage?: unknown }).localStorage;
  resetCommentCache();
});

describe("checkout key", () => {
  it("matches the MCP server's hash of the root path", () => {
    expect(workspaceKey("/repo/a")).toBe("564ecae661f01822");
    expect(workspaceKey("/Users/me/Ünï code")).toBe("8ce2db74dd47c88c");
    expect(workspaceKey("")).toBe("cbf29ce484222325");
  });

  it("keys a root the same with or without a trailing slash", () => {
    expect(commentsFolder(HOME, "/repo/a/")).toBe(FOLDER);
    expect(commentsFolder(`${HOME}/`, WS)).toBe(FOLDER);
  });
});

describe("agents' comments", () => {
  it("become pending comments under their lines, by their author", () => {
    const text = [
      row(),
      row({ id: "a1-1", file: "/repo/a/src/y.ts", line: 2, end_line: 6, side: "old", author: "" }),
    ].join("\n");
    const [a, b] = parseAgentComments(text, WS);
    expect(a).toMatchObject({
      id: "a1-0",
      workspace: WS,
      filePath: "src/x.ts",
      lineNumber: 4,
      side: "additions",
      state: "pending",
      author: "Claude Code",
      createdAt: 1000,
    });
    expect(a.endLineNumber).toBeUndefined();
    expect(b).toMatchObject({ filePath: "src/y.ts", endLineNumber: 6, side: "deletions", author: "Agent" });
  });

  it("skips broken lines and another checkout's", () => {
    const text = [
      "{not json",
      "",
      row({ workspace: "/repo/b" }),
      row({ line: 0 }),
      row({ line: 2.5 }),
      row({ body: 3 }),
      row({ id: "ok" }),
    ].join("\n");
    expect(parseAgentComments(text, WS).map((c) => c.id)).toEqual(["ok"]);
  });

  it("arrive from the checkout's file, and reading it again changes nothing", async () => {
    disk.set(`${FOLDER}/agent.jsonl`, `${row()}\n`);
    let told = 0;
    const off = subscribeComments(() => told++);
    expect(await syncAgentComments(WS)).toBe(1);
    expect(listComments(WS, "src/x.ts")).toHaveLength(1);
    expect(told).toBe(1);
    await syncAgentComments(WS);
    expect(told).toBe(1);
    off();
  });

  it("one sent back in chat stays off the diff when the file is read again", async () => {
    disk.set(`${FOLDER}/agent.jsonl`, `${row()}\n`);
    await syncAgentComments(WS);
    markReviewed((c) => c.id === "a1-0");
    await syncAgentComments(WS);
    expect(listComments(WS, "src/x.ts")).toHaveLength(0);
    expect(listComments(WS)[0].state).toBe("reviewed");
  });

  it("nothing posted yet is not an error", async () => {
    expect(await syncAgentComments(WS)).toBe(0);
    expect(listComments(WS)).toHaveLength(0);
  });
});

describe("the copy agents read", () => {
  it("carries your comments and agents', with states, drafts left out", () => {
    const d = addDraft({ workspace: WS, filePath: "f", lineNumber: 3, endLineNumber: 5, side: "deletions" })!;
    saveComment(WS, d.id, "rename this");
    addDraft({ workspace: WS, filePath: "f", lineNumber: 9, side: "additions" });
    const parsed = JSON.parse(appCopy(WS, listComments(WS)));
    expect(parsed.workspace).toBe(WS);
    expect(parsed.comments).toEqual([
      {
        id: d.id,
        file: "f",
        line: 3,
        end_line: 5,
        side: "old",
        body: "rename this",
        state: "ready_for_review",
        created_at: expect.any(Number),
      },
    ]);
  });

  it("is written beside the agents' file, and only when it changed", async () => {
    const d = addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" })!;
    saveComment(WS, d.id, "x");
    expect(await writeAppCopy(WS)).toBe(true);
    expect(dirs).toEqual([`${HOME}/.aura/review-comments`, FOLDER]);
    expect(JSON.parse(disk.get(`${FOLDER}/app.json`)!).comments).toHaveLength(1);
    expect(await writeAppCopy(WS)).toBe(false);
  });

  it("follows the book while the checkout is watched", async () => {
    const stop = watchAgentComments(WS);
    const d = addDraft({ workspace: WS, filePath: "f", lineNumber: 1, side: "additions" })!;
    saveComment(WS, d.id, "x");
    await new Promise((r) => setTimeout(r, MIRROR_DELAY_MS + 50));
    expect(JSON.parse(disk.get(`${FOLDER}/app.json`)!).comments[0].body).toBe("x");
    stop();
  });
});

describe("watching", () => {
  it("counts every view of a checkout and stops with the last", () => {
    const a = watchAgentComments(WS);
    const b = watchAgentComments(WS);
    expect(watchedCount(WS)).toBe(2);
    a();
    a();
    expect(watchedCount(WS)).toBe(1);
    b();
    expect(watchedCount(WS)).toBe(0);
    expect(watchAgentComments("")).toBeInstanceOf(Function);
    expect(watchedCount("")).toBe(0);
  });

  it("reads the checkout's file as soon as it starts", async () => {
    disk.set(`${FOLDER}/agent.jsonl`, `${row()}\n`);
    const stop = watchAgentComments(WS);
    await new Promise((r) => setTimeout(r, 10));
    expect(listComments(WS, "src/x.ts")).toHaveLength(1);
    stop();
  });
});
