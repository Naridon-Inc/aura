// What a workspace's comments add up to, as the screen draws them. Pure: the
// hook that reads and follows them is `useWorkspaceFeedback`.
//
// Two sources feed one state. `/feedback` answers with the comments changed
// since a cursor; the live socket sends one comment as it now stands after
// each write. Comments merge by id, the newer change winning. A comment
// changed at exactly the cursor time comes back on the next read, so seeing
// one twice changes nothing. The cloud still answers with reactions, and the
// socket still sends them; the chat no longer shows them, so both are left
// unread.

import { commentRow, type CommentDto, type FeedbackPage } from "../../lib/cloudFeedbackApi";

export type FeedbackState = {
  /** Every comment seen, deleted ones included, by id. */
  comments: Record<string, CommentDto>;
  /** Where the next read starts. */
  asOf: string | null;
  /** A first read has landed. */
  read: boolean;
};

export const EMPTY_FEEDBACK: FeedbackState = { comments: {}, asOf: null, read: false };

const time = (s: string | null | undefined) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? t : 0;
};

/** One comment merged in: a row older than the one held is a stale copy. */
export function withComment(state: FeedbackState, c: CommentDto): FeedbackState {
  const held = state.comments[c.id];
  if (held && time(held.updated_at) > time(c.updated_at)) return state;
  return { ...state, comments: { ...state.comments, [c.id]: c } };
}

/** One read of `/feedback` merged in. */
export function withPage(state: FeedbackState, page: FeedbackPage): FeedbackState {
  let next = state;
  for (const c of page.comments) next = withComment(next, c);
  return { ...next, asOf: page.as_of ?? state.asOf, read: true };
}

/** A `kind: "feedback"` frame off the live socket merged in. Anything else,
 *  or a frame missing what it should carry, leaves the state as it was. */
export function withFrame(state: FeedbackState, frame: unknown): FeedbackState {
  const f = (frame && typeof frame === "object" ? frame : {}) as Record<string, unknown>;
  if (f.kind !== "feedback") return state;
  if (f.op === "comment") {
    const c = commentRow(f.comment);
    return c ? withComment(state, c) : state;
  }
  return state;
}

// ── Comments ───────────────────────────────────────────────────────────────

export type Thread = { root: CommentDto; replies: CommentDto[] };

const byCreated = (a: CommentDto, b: CommentDto) => time(a.created_at) - time(b.created_at);

/** Every thread, oldest first, by the turn it is on, and the workspace's own.
 *  A thread nothing is left of (its start and every reply deleted) is gone. */
export function threadsOf(comments: Record<string, CommentDto>): {
  byTurn: Record<string, Thread[]>;
  workspace: Thread[];
} {
  const all = Object.values(comments);
  const replies: Record<string, CommentDto[]> = {};
  for (const c of all) if (c.parent_id) (replies[c.parent_id] ??= []).push(c);
  const out: { byTurn: Record<string, Thread[]>; workspace: Thread[] } = { byTurn: {}, workspace: [] };
  for (const root of all.filter((c) => !c.parent_id).sort(byCreated)) {
    const thread = { root, replies: (replies[root.id] ?? []).sort(byCreated) };
    if (root.deleted && thread.replies.every((r) => r.deleted)) continue;
    if (root.message_id) (out.byTurn[root.message_id] ??= []).push(thread);
    else out.workspace.push(thread);
  }
  return out;
}

export const isResolved = (t: Thread) => !!t.root.resolved_at;

/** How many comments the threads hold that aren't deleted. */
export function commentCount(threads: readonly Thread[] | undefined): number {
  let n = 0;
  for (const t of threads ?? []) for (const c of [t.root, ...t.replies]) if (!c.deleted) n += 1;
  return n;
}

/** Who wrote in the threads, in the order they first did. */
export function writersOf(threads: readonly Thread[], me: string | null): string[] {
  const out: string[] = [];
  for (const t of threads)
    for (const c of [t.root, ...t.replies]) {
      if (c.deleted) continue;
      const name = me && c.author_id === me ? "You" : (c.author_name ?? "Someone");
      if (!out.includes(name)) out.push(name);
    }
  return out;
}

/** "2 comments · Priya, Sam" — a folded thread's one line. */
export function threadLine(threads: readonly Thread[], me: string | null): string {
  const n = commentCount(threads);
  const who = writersOf(threads, me);
  const count = `${n} ${n === 1 ? "comment" : "comments"}`;
  if (!who.length) return count;
  const names = who.length > 3 ? `${who.slice(0, 3).join(", ")} +${who.length - 3}` : who.join(", ");
  return `${count} · ${names}`;
}

/** What a comment reads as: its text, or that it was deleted. */
export const commentText = (c: CommentDto) => (c.deleted ? "Comment deleted" : c.body);

/** You may change or delete only what you wrote. */
export const isOwn = (c: CommentDto, me: string | null) => !!me && !c.deleted && c.author_id === me;

// ── A machine chat's own copy ──────────────────────────────────────────────

/** A turn on the laptop that drives a machine chat, as far as the cloud is
 *  concerned: its copy's id when it was filed from the log, and the key it
 *  was kept on the log under when this laptop sent it. */
export type KeyedTurn = { cloud_id?: string | null; cloud_key?: string | null };

/** Every key the cloud has named a turn by, to that turn's id: from the
 *  comments (`message_key`), and from the copies this laptop's relay kept. */
export function turnIdsByKey(
  state: FeedbackState,
  kept: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...kept };
  for (const c of Object.values(state.comments))
    if (c.message_key && c.message_id) out[c.message_key] = c.message_id;
  return out;
}

/** The cloud id of a turn on the driver's laptop, or null when the cloud has
 *  no copy of it this laptop can name. Never matched by its text. */
export function turnIdOf(turn: KeyedTurn, ids: Readonly<Record<string, string>>): string | null {
  if (turn.cloud_id) return turn.cloud_id;
  if (turn.cloud_key) return ids[turn.cloud_key] ?? null;
  return null;
}

// ── Notifications and hand-offs ────────────────────────────────────────────

export type InboxKind = "mention" | "reply" | "comment";

export function inboxKind(v: unknown): InboxKind {
  return v === "reply" || v === "comment" ? v : "mention";
}

/** The line a desktop notification says, for each kind of inbox row: where
 *  it happened, when the row names the workspace. */
export function noticeLine(kind: InboxKind, who: string, where: string | null): string {
  const name = who.trim() || "Someone";
  const place = where?.trim();
  if (kind === "reply") return place ? `${name} replied in ${place}` : `${name} replied in a thread you’re in`;
  if (kind === "comment")
    return place ? `${name} commented on your message in ${place}` : `${name} commented on your message`;
  return place ? `${name} mentioned you in ${place}` : `${name} mentioned you`;
}

/** A comment handed to the agent, in the prompt box, for the person to send. */
export function saidLine(who: string | null, body: string): string {
  return `${(who ?? "").trim() || "A teammate"} said: ${body.trim()}`;
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** One read at a time per generation (a workspace opened, or opened again).
 *  A read still out for an earlier generation never holds off the first read
 *  of the next: that one throws its answer away when it lands, so waiting on
 *  it would leave the new workspace empty until the next check. */
export function readGate() {
  let busy = 0;
  return {
    /** May a read start for this generation? Marks it under way if so. */
    begin(gen: number): boolean {
      if (busy === gen) return false;
      busy = gen;
      return true;
    },
    /** The read for this generation is done. A later generation's read
     *  stays marked. */
    end(gen: number): void {
      if (busy === gen) busy = 0;
    },
  };
}
