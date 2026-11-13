// Comments on a cloud workspace's turns, through the desktop's commands
// (`cmd_cloud_feedback.rs`), so the renderer never holds the token.
//
// Anyone who can open a workspace can comment, including a member who may not
// prompt its agent. A comment starts a thread on a turn (or on the workspace
// as a whole), and a thread takes replies one level deep. The cloud also keeps
// reactions; the chat no longer shows or sends them, so their rows in a read
// are left unread.

import { invoke } from "@tauri-apps/api/core";

import { cloudProblem } from "./cloudWorkspacesApi";

/** A comment's longest text. */
export const COMMENT_MAX = 4000;

export type CommentDto = {
  id: string;
  /** The turn it is on, or null for a comment on the workspace. */
  message_id: string | null;
  /** The key the machine that drove the chat kept this turn under. */
  message_key: string | null;
  /** The thread it replies to, or null when it starts one. */
  parent_id: string | null;
  /** Null when the account that wrote it is gone. */
  author_id: string | null;
  author_name: string | null;
  /** Empty once deleted. */
  body: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
};

/** One read of `/feedback`: the comments changed since the cursor, the next
 *  cursor, and whether there is more to read. */
export type FeedbackPage = {
  comments: CommentDto[];
  as_of: string | null;
  more: boolean;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function commentRow(v: unknown): CommentDto | null {
  const o = obj(v);
  const id = str(o.id);
  if (!id) return null;
  const created_at = str(o.created_at) ?? "";
  return {
    id,
    message_id: str(o.message_id),
    message_key: str(o.message_key),
    parent_id: str(o.parent_id),
    author_id: str(o.author_id),
    author_name: str(o.author_name),
    body: str(o.body) ?? "",
    created_at,
    updated_at: str(o.updated_at) ?? created_at,
    edited_at: str(o.edited_at),
    deleted: o.deleted === true,
    resolved_at: str(o.resolved_at),
    resolved_by: str(o.resolved_by),
  };
}

const rows = <T>(v: unknown, row: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(row).filter((x): x is T => x !== null) : [];

export function feedbackPage(v: unknown): FeedbackPage {
  const o = obj(v);
  return {
    comments: rows(o.comments, commentRow),
    as_of: str(o.as_of),
    more: o.more === true,
  };
}

function comment(v: unknown): CommentDto {
  const c = commentRow(v);
  if (!c) throw new Error("The cloud answered without the comment.");
  return c;
}

/** What went wrong, in words for the screen. The server's own sentence when
 *  it gave one ("this comment was deleted", "workspace is archived"), else
 *  what `cloudProblem` reads out of the failure. */
export function feedbackProblem(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /^HTTP (\d{3})[^:]*:\s*([\s\S]*)$/.exec(raw);
  if (m) {
    const status = Number(m[1]);
    let said: string | null = null;
    try {
      const body = obj(JSON.parse(m[2]));
      said = str(body.message) ?? str(body.error);
    } catch {
      said = null;
    }
    if (status === 409 && said?.toLowerCase().includes("archived"))
      return "This workspace is archived, so it can’t take comments.";
    if (status === 409 && said?.toLowerCase().includes("deleted")) return "That comment was deleted.";
    if (status === 404 && said?.toLowerCase().includes("message"))
      return "That message isn’t in this workspace any more.";
    if (status === 403 && said) return said.charAt(0).toUpperCase() + said.slice(1);
    if (status === 400 && said) return said.charAt(0).toUpperCase() + said.slice(1);
  }
  return cloudProblem(e).message;
}

export const feedbackApi = {
  read: (id: string, since: string | null) =>
    invoke<unknown>("cloud_feedback_read", { id, since }).then(feedbackPage),
  comment: (
    id: string,
    to: { messageId?: string | null; parentId?: string | null },
    body: string,
    key?: string,
  ) =>
    invoke<unknown>("cloud_comment_create", {
      id,
      messageId: to.messageId ?? null,
      parentId: to.parentId ?? null,
      body,
      key: key ?? null,
    }).then(comment),
  edit: (id: string, commentId: string, body: string) =>
    invoke<unknown>("cloud_comment_edit", { id, commentId, body }).then(comment),
  remove: (id: string, commentId: string) =>
    invoke<unknown>("cloud_comment_delete", { id, commentId }).then(comment),
  resolve: (id: string, commentId: string) =>
    invoke<unknown>("cloud_comment_resolve", { id, commentId }).then(comment),
  reopen: (id: string, commentId: string) =>
    invoke<unknown>("cloud_comment_reopen", { id, commentId }).then(comment),
  /** The cloud ids this laptop got back for the turns its machine chat kept,
   *  by the key each was kept under. */
  keptTurnIds: (id: string) =>
    invoke<Record<string, string>>("cloud_box_turn_ids", { id }).catch(() => ({}) as Record<string, string>),
};
