// Review comments left on the lines of a diff, kept on this device.
//
// A comment belongs to one workspace (its checkout root) and one file, and
// sits on a line or a run of lines of either side of the diff: the new file
// ("additions") or the old one ("deletions"). Picking a line makes an empty
// draft there; writing and sending it makes it ready for review and hands it
// to the chat. An agent's comments arrive already written, as pending, with
// the agent as their author (see agentComments.ts). Once a chat message
// carrying a comment is sent, the comment is reviewed and leaves the diff.
// Nothing here is sent anywhere — the record lives in local storage and the
// chat gets a copy as an attachment (see commentChat.ts).
//
// Separate from the stored record are edit drafts: the text being typed into
// an editor for a comment that already exists, so a second render of the same
// comment opens on what was being written rather than what was saved. Those
// live in memory only.

export type CommentSide = "additions" | "deletions";

/** "draft": just opened on a line, never sent. "ready_for_review": written by
 *  you. "pending": left by an agent. "reviewed": sent to the chat in a
 *  message, so no longer shown on the diff. */
export type CommentState = "draft" | "pending" | "ready_for_review" | "reviewed";

/** Whose comment it is: one with an author came from an agent. */
export function commentKind(c: Pick<ReviewComment, "author">): "agent-local" | "user-local" {
  return c.author !== undefined ? "agent-local" : "user-local";
}

/** Whether the diff draws the comment: on a line, and not yet reviewed. */
export function shownOnDiff(c: Pick<ReviewComment, "lineNumber" | "state">): boolean {
  return c.lineNumber > 0 && c.state !== "reviewed";
}

export type ReviewComment = {
  id: string;
  workspace: string;
  filePath: string;
  /** First line of the comment's run, 1-based, on `side`. */
  lineNumber: number;
  /** Last line when the comment covers more than one; left out for one. */
  endLineNumber?: number;
  side: CommentSide;
  body: string;
  state: CommentState;
  createdAt: number;
  /** Who wrote it, when it was not you: the agent's model name. */
  author?: string;
  authorAvatarUrl?: string;
  /** The code the comment's lines held when it was opened, so a suggestion
   *  block in the body can be shown as a change against it. */
  suggestionBaseCode?: string;
};

type Book = Record<string, ReviewComment[]>;

export const COMMENTS_KEY = "aura.diffReview.comments.v1";

const listeners = new Set<() => void>();
let cache: Book | null = null;

function read(): Book {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(COMMENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? upgrade(parsed as Book) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Comments saved before the states had names were "saved": written by you. */
function upgrade(book: Book): Book {
  const out: Book = {};
  for (const [ws, list] of Object.entries(book)) {
    out[ws] = Array.isArray(list)
      ? list.map((c) => ((c.state as string) === "saved" ? { ...c, state: "ready_for_review" } : c))
      : [];
  }
  return out;
}

function write(next: Book) {
  cache = next;
  try {
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or disabled — the comments still live for this session */
  }
  for (const fn of listeners) fn();
}

function update(workspace: string, fn: (list: ReviewComment[]) => ReviewComment[]) {
  const book = read();
  const list = fn(book[workspace] ?? []);
  const next = { ...book };
  if (list.length > 0) next[workspace] = list;
  else delete next[workspace];
  write(next);
}

export function subscribeComments(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Drop the in-memory copy so the next read comes from storage. Tests only. */
export function resetCommentCache(): void {
  cache = null;
}

const EMPTY: ReviewComment[] = [];

/** The path comments are kept under: relative to the workspace, so a file
 *  opened by its full path and one listed by its relative path share them. */
export function workspacePath(workspace: string, path: string): string {
  const root = workspace.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** A workspace's comments, or the ones one file's diff shows. The same array
 *  comes back until something changes, so it can feed `useSyncExternalStore`. */
export function listComments(workspace: string, filePath?: string): ReviewComment[] {
  const all = read()[workspace] ?? EMPTY;
  if (filePath === undefined) return all;
  const key = `${workspace}\u0000${filePath}`;
  const hit = fileViews.get(key);
  if (hit && hit.from === all) return hit.list;
  const list = all.filter((c) => c.filePath === filePath && shownOnDiff(c));
  fileViews.set(key, { from: all, list: list.length ? list : EMPTY });
  return list.length ? list : EMPTY;
}
const fileViews = new Map<string, { from: ReviewComment[]; list: ReviewComment[] }>();

export function getComment(workspace: string, id: string): ReviewComment | undefined {
  return (read()[workspace] ?? EMPTY).find((c) => c.id === id);
}

/** How many comments each file's diff shows, drafts left out. */
export function commentCounts(workspace: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of read()[workspace] ?? EMPTY) {
    if (c.state === "draft" || !shownOnDiff(c)) continue;
    out[c.filePath] = (out[c.filePath] ?? 0) + 1;
  }
  return out;
}

function newId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${Date.now().toString(36)}${rand}`;
}

/** Open an empty draft on a line, or a run of lines. Picking the same run on
 *  the same side again while its draft is still open does nothing. */
export function addDraft(input: {
  workspace: string;
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  side: CommentSide;
  suggestionBaseCode?: string;
}): ReviewComment | null {
  const end =
    input.endLineNumber !== undefined && input.endLineNumber !== input.lineNumber
      ? input.endLineNumber
      : undefined;
  const open = (read()[input.workspace] ?? EMPTY).some(
    (c) =>
      c.filePath === input.filePath &&
      c.state === "draft" &&
      c.lineNumber === input.lineNumber &&
      c.endLineNumber === end &&
      c.side === input.side,
  );
  if (open) return null;
  const comment: ReviewComment = {
    id: newId(),
    workspace: input.workspace,
    filePath: input.filePath,
    lineNumber: input.lineNumber,
    ...(end !== undefined ? { endLineNumber: end } : {}),
    side: input.side,
    body: "",
    state: "draft",
    createdAt: Date.now(),
    ...(input.suggestionBaseCode !== undefined
      ? { suggestionBaseCode: input.suggestionBaseCode }
      : {}),
  };
  update(input.workspace, (list) => [...list, comment]);
  return comment;
}

/** Write a comment's text. A draft becomes ready for review, dated now. */
export function saveComment(workspace: string, id: string, body: string): ReviewComment | null {
  let saved: ReviewComment | null = null;
  update(workspace, (list) =>
    list.map((c) => {
      if (c.id !== id) return c;
      saved = c.state === "draft" ? { ...c, body, state: "ready_for_review", createdAt: Date.now() } : { ...c, body };
      return saved;
    }),
  );
  return saved;
}

export function deleteComment(workspace: string, id: string): void {
  update(workspace, (list) => list.filter((c) => c.id !== id));
}

/** Add comments that arrived from elsewhere — an agent's — or refresh ones
 *  already here. A comment already reviewed keeps its state and text. When
 *  nothing would change, nothing is written and no one is told. */
export function upsertComments(workspace: string, incoming: ReviewComment[]): void {
  if (incoming.length === 0) return;
  const list = read()[workspace] ?? EMPTY;
  const byId = new Map(list.map((c, i) => [c.id, i]));
  const next = [...list];
  let changed = false;
  for (const c of incoming) {
    const at = byId.get(c.id);
    if (at === undefined) {
      byId.set(c.id, next.length);
      next.push(c);
      changed = true;
      continue;
    }
    const was = next[at];
    if (was.state === "reviewed") continue;
    const merged: ReviewComment = { ...was, ...c, state: was.state === "draft" ? "draft" : c.state };
    if (sameComment(was, merged)) continue;
    next[at] = merged;
    changed = true;
  }
  if (changed) update(workspace, () => next);
}

function sameComment(a: ReviewComment, b: ReviewComment): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (ra[k] !== rb[k]) return false;
  return true;
}

/** Every comment the test says was sent becomes reviewed, in any workspace. */
export function markReviewed(sent: (c: ReviewComment) => boolean): number {
  const book = read();
  let changed = 0;
  const next: Book = {};
  for (const [ws, list] of Object.entries(book)) {
    next[ws] = list.map((c) => {
      if (c.state === "reviewed" || c.state === "draft" || !sent(c)) return c;
      changed++;
      return { ...c, state: "reviewed" };
    });
  }
  if (changed > 0) write(next);
  return changed;
}

/** "Lines 4–9" over a comment that covers more than one line; nothing for one. */
export function commentRangeLabel(c: Pick<ReviewComment, "lineNumber" | "endLineNumber">): string | null {
  if (c.endLineNumber === undefined || c.endLineNumber <= c.lineNumber) return null;
  return `Lines ${c.lineNumber}–${c.endLineNumber}`;
}

/** Where a comment's card goes: under the last line it covers. */
export function anchorLine(c: Pick<ReviewComment, "lineNumber" | "endLineNumber">): number {
  return c.endLineNumber ?? c.lineNumber;
}

// ── edit drafts ─────────────────────────────────────────────────────────────

const drafts = new Map<string, { body: string }>();
const draftListeners = new Set<() => void>();
let draftVersion = 0;

function emitDrafts() {
  draftVersion++;
  for (const fn of draftListeners) fn();
}

export function subscribeDrafts(fn: () => void): () => void {
  draftListeners.add(fn);
  return () => {
    draftListeners.delete(fn);
  };
}

export function draftsVersion(): number {
  return draftVersion;
}

/** Start editing a saved comment. A draft already open for it is kept. */
export function startEdit(id: string, body: string): void {
  if (drafts.has(id)) return;
  drafts.set(id, { body });
  emitDrafts();
}

export function updateDraftBody(id: string, body: string): void {
  drafts.set(id, { body });
  emitDrafts();
}

export function discardDraft(id: string): void {
  if (!drafts.delete(id)) return;
  emitDrafts();
}

export function getDraft(id: string): { body: string } | undefined {
  return drafts.get(id);
}

/** Whether cancelling the editor should ask first: an edit whose text moved
 *  away from what was saved, or a new comment with something written in it. */
export function cancelNeedsConfirm(input: {
  editing: boolean;
  saved: string;
  current: string;
}): boolean {
  return input.editing ? input.current !== input.saved : input.current.trim().length > 0;
}

/** The line under the "Discard comment?" title. */
export function discardDescription(editing: boolean): string {
  return editing ? "Your changes to this comment will be lost." : "This comment will be lost.";
}

// ── suggested changes ───────────────────────────────────────────────────────

export type BodyPart = { kind: "text"; text: string } | { kind: "suggestion"; code: string };

/** Split a comment body around its ```suggestion blocks. */
export function splitSuggestions(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  const re = /```suggestion[^\n]*\n([\s\S]*?)(?:\n)?```/g;
  let at = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > at) parts.push({ kind: "text", text: body.slice(at, m.index) });
    parts.push({ kind: "suggestion", code: m[1] });
    at = m.index + m[0].length;
  }
  if (at < body.length) parts.push({ kind: "text", text: body.slice(at) });
  return parts.filter((p) => p.kind === "suggestion" || p.text.trim().length > 0);
}

/** Lines with blank edges trimmed and their shared indent taken off, the way
 *  a suggested change shows the code it replaces. */
export function dedent(code: string): string {
  const lines = code.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => Math.min(min, l.match(/^(\s*)/)?.[1]?.length ?? 0), Infinity);
  return indent > 0 && Number.isFinite(indent)
    ? lines.map((l) => l.slice(indent)).join("\n")
    : lines.join("\n");
}

/** The when line of a comment: "Nov 9, 3:04 PM". */
export function commentTime(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
