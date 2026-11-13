// Comments an agent leaves on the diff, and the copy of yours an agent reads.
//
// An agent posts review comments through Aura's MCP server
// (`aura_review_comment_add`), which appends them to a file on this machine:
// `~/.aura/review-comments/<key>/agent.jsonl`, `<key>` being the FNV-1a 64
// hash of the checkout's root path (the server computes the same one). While
// a diff of that checkout is open, this module reads the file every few
// seconds and adds what is new to the comment book as pending comments with
// the agent as author, so they show under their lines.
//
// The other way, every change to a watched checkout's comments is written to
// `app.json` beside it, so `aura_review_comments_list` can hand the agent the
// comments you wrote and tell it which of its own were already sent back.

import { api } from "../api";
import {
  listComments,
  subscribeComments,
  upsertComments,
  workspacePath,
  type ReviewComment,
} from "./reviewComments";

/** FNV-1a, 64-bit, over the path's UTF-8 bytes, as 16 hex digits. */
export function workspaceKey(root: string): string {
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(root)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** The checkout's root as both sides key it: no trailing slash. */
export function rootKeyPath(workspace: string): string {
  const t = workspace.replace(/\/+$/, "");
  return t || "/";
}

export function commentsFolder(home: string, workspace: string): string {
  return `${home.replace(/\/+$/, "")}/.aura/review-comments/${workspaceKey(rootKeyPath(workspace))}`;
}

type AgentRow = {
  id?: unknown;
  workspace?: unknown;
  file?: unknown;
  line?: unknown;
  end_line?: unknown;
  side?: unknown;
  body?: unknown;
  author?: unknown;
  created_at?: unknown;
};

/** The agents' file as comments of `workspace`. A line that is not a whole
 *  comment for this checkout is skipped. */
export function parseAgentComments(text: string, workspace: string): ReviewComment[] {
  const root = rootKeyPath(workspace);
  const out: ReviewComment[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let row: AgentRow;
    try {
      row = JSON.parse(raw) as AgentRow;
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || row.workspace !== root) continue;
    const line = row.line;
    if (typeof row.id !== "string" || typeof row.file !== "string" || typeof row.body !== "string") continue;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) continue;
    const end =
      typeof row.end_line === "number" && Number.isInteger(row.end_line) && row.end_line > line
        ? row.end_line
        : undefined;
    out.push({
      id: row.id,
      workspace,
      filePath: workspacePath(workspace, row.file),
      lineNumber: line,
      ...(end !== undefined ? { endLineNumber: end } : {}),
      side: row.side === "old" ? "deletions" : "additions",
      body: row.body,
      state: "pending",
      createdAt: typeof row.created_at === "number" ? row.created_at : 0,
      author: typeof row.author === "string" && row.author.trim() ? row.author : "Agent",
    });
  }
  return out;
}

/** What `app.json` holds for a checkout: every comment but open drafts. */
export function appCopy(workspace: string, comments: ReviewComment[]): string {
  return JSON.stringify({
    workspace: rootKeyPath(workspace),
    comments: comments
      .filter((c) => c.state !== "draft")
      .map((c) => ({
        id: c.id,
        file: c.filePath,
        line: c.lineNumber,
        ...(c.endLineNumber !== undefined ? { end_line: c.endLineNumber } : {}),
        side: c.side === "deletions" ? "old" : "new",
        body: c.body,
        state: c.state,
        ...(c.author !== undefined ? { author: c.author } : {}),
        created_at: c.createdAt,
      })),
  });
}

/** How the module reaches the disk; the app's file commands unless a test
 *  hands in its own. */
export type CommentFiles = {
  home: () => Promise<string>;
  read: (path: string) => Promise<string | null>;
  write: (path: string, text: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
};

const appFiles: CommentFiles = {
  home: () => api.homeDir(),
  read: async (path) => {
    try {
      const f = await api.readFile(path);
      return f.status === "ok" ? f.text : null;
    } catch {
      return null; // nothing posted yet
    }
  },
  write: (path, text) => api.writeFile(path, text),
  mkdir: async (path) => {
    try {
      await api.fsCreateFolder(path);
    } catch {
      /* already there */
    }
  },
};

let files: CommentFiles = appFiles;
let homeDir: Promise<string> | null = null;

function home(): Promise<string> {
  homeDir ??= files.home();
  return homeDir;
}

/** Read what agents posted for `workspace` and add it to the book. */
export async function syncAgentComments(workspace: string): Promise<number> {
  const folder = commentsFolder(await home(), workspace);
  const text = await files.read(`${folder}/agent.jsonl`);
  if (!text) return 0;
  const incoming = parseAgentComments(text, workspace);
  upsertComments(workspace, incoming);
  return incoming.length;
}

// ── the copy agents read ────────────────────────────────────────────────────

const written = new Map<string, string>();
const mirrored = new Map<string, ReviewComment[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const known = new Set<string>();
let unsubscribe: (() => void) | null = null;

export const MIRROR_DELAY_MS = 400;

/** Write `app.json` for `workspace` if it changed since the last write. */
export async function writeAppCopy(workspace: string): Promise<boolean> {
  const list = listComments(workspace);
  mirrored.set(workspace, list);
  const text = appCopy(workspace, list);
  if (written.get(workspace) === text) return false;
  const h = await home();
  const base = `${h.replace(/\/+$/, "")}/.aura/review-comments`;
  await files.mkdir(base);
  const folder = commentsFolder(h, workspace);
  await files.mkdir(folder);
  await files.write(`${folder}/app.json`, text);
  written.set(workspace, text);
  return true;
}

function scheduleMirrors() {
  for (const ws of known) {
    if (mirrored.get(ws) === listComments(ws) || timers.has(ws)) continue;
    timers.set(
      ws,
      setTimeout(() => {
        timers.delete(ws);
        writeAppCopy(ws).catch(() => {
          /* the copy is a convenience for agents; the book is the record */
        });
      }, MIRROR_DELAY_MS),
    );
  }
}

// ── watching ────────────────────────────────────────────────────────────────

export const POLL_MS = 3000;

const watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

function tick(workspace: string) {
  syncAgentComments(workspace).catch(() => {
    /* the app may not be able to read the file yet; try again next tick */
  });
}

/** While anything shows `workspace`'s diff: pick up agents' comments as they
 *  arrive and keep the agents' copy current. Returns the stop function. */
export function watchAgentComments(workspace: string): () => void {
  if (!workspace) return () => {};
  known.add(workspace);
  unsubscribe ??= subscribeComments(scheduleMirrors);
  const w = watchers.get(workspace);
  if (w) {
    w.count++;
  } else {
    tick(workspace);
    scheduleMirrors();
    watchers.set(workspace, { count: 1, timer: setInterval(() => tick(workspace), POLL_MS) });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const cur = watchers.get(workspace);
    if (!cur) return;
    cur.count--;
    if (cur.count > 0) return;
    clearInterval(cur.timer);
    watchers.delete(workspace);
  };
}

/** Swap the disk for a test's and forget everything watched. Tests only. */
export function resetAgentComments(next?: CommentFiles): void {
  for (const w of watchers.values()) clearInterval(w.timer);
  for (const t of timers.values()) clearTimeout(t);
  watchers.clear();
  timers.clear();
  written.clear();
  mirrored.clear();
  known.clear();
  unsubscribe?.();
  unsubscribe = null;
  homeDir = null;
  files = next ?? appFiles;
}

export function watchedCount(workspace: string): number {
  return watchers.get(workspace)?.count ?? 0;
}
