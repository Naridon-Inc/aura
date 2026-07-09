// pagesApi — thin, typed invoke wrappers for the Pages backend, scoped to
// the pages2 surface so this surface owns its own data layer and never reaches
// into the shared src/lib/api.ts (another agent owns the shared bindings).
//
// Arg-key convention mirrors the EXISTING notes_* commands verbatim: the
// established commands take a single `input` object with snake_case keys
// (see src/lib/api.ts notesRead/notesWrite/etc.). The two NEW commands the
// orchestrator is adding concurrently — notes_archive / notes_set_parent —
// take flat camelCase keys (repoRoot, scope, bucket, id, …) to match the
// snake_case Tauri command name + the project's camelCase arg style.

import { invoke } from "@tauri-apps/api/core";

export type NoteScope = "team" | "channel" | "member";

export type NoteFrontmatter = {
  title?: string | null;
  author?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  visibility?: string | null;
  /** Lock toggle — when true the page is read-only in the editor. */
  locked?: boolean | null;
  tags: string[];
  /** Tree parent — null/absent for a top-level page. */
  parent_id?: string | null;
  /** ISO timestamp set when the page was archived; absent when active. */
  archived_at?: string | null;
  /** Optional leading glyph (emoji or short token) shown on the row. */
  icon?: string | null;
  /** Folder id this page lives in; null/absent ⇒ a root page. */
  folder?: string | null;
  /** Handles the backend extracted from `@handle` tokens in the body. */
  mentioned_handles?: string[] | null;
};

export type NoteSummary = {
  id: string;
  scope: NoteScope;
  bucket: string;
  title: string;
  updated_at: string;
  tags: string[];
  visibility: string;
  /** Tree parent — null/absent for a top-level page. */
  parent_id?: string | null;
  /** Present (ISO ts) when the page is archived. */
  archived_at?: string | null;
  /** Folder id this page lives in; null/absent ⇒ a root page. */
  folder?: string | null;
};

export type Note = {
  id: string;
  scope: NoteScope;
  bucket: string;
  frontmatter: NoteFrontmatter;
  body: string;
  raw: string;
};

export type NoteSearchHit = {
  note: NoteSummary;
  /** ~120-char window around the first match in the body. */
  snippet: string;
  match_count: number;
};

export type PageSyncPollResult = {
  changed: boolean;
  applied_ids: string[];
  removed_ids: string[];
  next_seq: number;
};

export type NotesListInput = {
  repoRoot: string;
  scope?: NoteScope;
  bucket?: string;
};

export type NotesWriteInput = {
  repoRoot: string;
  scope: NoteScope;
  bucket?: string;
  id?: string;
  body: string;
  title?: string;
  author?: string;
  visibility?: string;
  locked?: boolean;
  tags?: string[];
  parentId?: string | null;
  archivedAt?: string | null;
  icon?: string | null;
  /** Folder membership. Omit (or pass null) to leave the page's folder
   *  untouched on a body save — folder moves go through {@link noteSetFolder}. */
  folder?: string | null;
};

/** List page summaries for a repo. */
export function notesList(input: NotesListInput): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_list", {
    input: {
      repo_root: input.repoRoot,
      scope: input.scope ?? null,
      bucket: input.bucket ?? null,
    },
  });
}

/** Read one page's frontmatter + body. */
export function notesRead(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
): Promise<Note> {
  return invoke<Note>("notes_read", {
    input: { repo_root: repoRoot, scope, bucket, id },
  });
}

/** Create (no id) or overwrite (id) a page. */
export function notesWrite(input: NotesWriteInput): Promise<Note> {
  return invoke<Note>("notes_write", {
    input: {
      repo_root: input.repoRoot,
      scope: input.scope,
      bucket: input.bucket ?? "",
      id: input.id ?? null,
      body: input.body,
      title: input.title ?? null,
      author: input.author ?? null,
      visibility: input.visibility ?? null,
      locked: input.locked ?? null,
      tags: input.tags ?? null,
      parent_id: input.parentId ?? null,
      archived_at: input.archivedAt ?? null,
      icon: input.icon ?? null,
      // null ⇒ leave the existing folder untouched (a body save never re-files
      // a page); folder moves use note_set_folder instead.
      folder: input.folder ?? null,
    },
  });
}

export function notesDelete(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
): Promise<void> {
  return invoke<void>("notes_delete", {
    input: { repo_root: repoRoot, scope, bucket, id },
  });
}

/** Pages that link to `title` via a page link (`[[Title]]`). */
export function notesBacklinks(
  repoRoot: string,
  title: string,
): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_backlinks", {
    input: { repo_root: repoRoot, title },
  });
}

/** Substring search across all pages; ordered by match count + recency. */
export function notesSearch(
  repoRoot: string,
  query: string,
  limit?: number,
): Promise<NoteSearchHit[]> {
  return invoke<NoteSearchHit[]>("notes_search", {
    input: { repo_root: repoRoot, query, limit: limit ?? null },
  });
}

/** Pull shared-page mutations off the live rail; returns changed:true when
 *  the list should be refetched. */
export function pagesSyncPoll(repoRoot: string): Promise<PageSyncPollResult> {
  return invoke<PageSyncPollResult>("pages_sync_poll", { repoRoot });
}

/** Repo-derived collab room id — the same fingerprint every teammate's clone
 *  derives locally, so the cloud relay can fan presence/ops out without auth.
 *  Mirrors api.deviceRoomId (the pages2 surface owns its own invoke layer). */
export function deviceRoomId(repoRoot: string): Promise<string> {
  return invoke<string>("device_room_id", { repoRoot });
}

/** Per-install device identity — `device_id` stamps presence frames so the
 *  socket can drop self-echoes. Mirrors api.deviceIdentity. */
export function deviceIdentity(): Promise<{
  device_id: string;
  display_name: string;
  email: string;
}> {
  return invoke<{ device_id: string; display_name: string; email: string }>(
    "device_identity",
  );
}

/** Archive (true) or restore (false) a page. NEW command — flat camelCase. */
export function notesArchive(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
  archived: boolean,
): Promise<Note> {
  return invoke<Note>("notes_archive", {
    repoRoot,
    scope,
    bucket,
    id,
    archived,
  });
}

/** Re-parent a page in the tree (null = move to top level). NEW command —
 *  flat camelCase. */
export function notesSetParent(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
  parentId: string | null,
): Promise<Note> {
  return invoke<Note>("notes_set_parent", {
    repoRoot,
    scope,
    bucket,
    id,
    parentId,
  });
}

// ─── Folders ──────────────────────────────────────────────────────────────
//
// A folder is a lightweight, user-organizational group for Pages — named +
// colored, optionally nested. Membership lives on the PAGE (its `folder`
// field), so a folder index never holds page bytes and deleting a folder only
// un-files its pages (never deletes them). These wrappers take flat camelCase
// keys to match the snake_case command names, the same convention
// `notesArchive` / `notesSetParent` use.

export type Folder = {
  id: string;
  name: string;
  /** Color token the UI maps to a swatch (see folderColors.ts). */
  color: string;
  /** Manual sort key within a parent; lower sorts first. */
  order: number;
  /** Parent folder id for nesting; null/absent ⇒ a top-level folder. */
  parent?: string | null;
};

/** List a scope/bucket's folders, ordered. Missing index ⇒ empty list. */
export function noteFoldersList(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
): Promise<Folder[]> {
  return invoke<Folder[]>("note_folders_list", { repoRoot, scope, bucket });
}

/** Create a folder (default color is a calm blue if unset). */
export function noteFolderCreate(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  name: string,
  color: string,
  parent?: string | null,
): Promise<Folder> {
  return invoke<Folder>("note_folder_create", {
    repoRoot,
    scope,
    bucket,
    name,
    color,
    parent: parent ?? null,
  });
}

/** Rename a folder (empty names are rejected). */
export function noteFolderRename(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
  name: string,
): Promise<Folder> {
  return invoke<Folder>("note_folder_rename", {
    repoRoot,
    scope,
    bucket,
    id,
    name,
  });
}

/** Change a folder's color token. */
export function noteFolderSetColor(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
  color: string,
): Promise<Folder> {
  return invoke<Folder>("note_folder_set_color", {
    repoRoot,
    scope,
    bucket,
    id,
    color,
  });
}

/** Reorder folders by their new id order; returns the sorted list. */
export function noteFolderReorder(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  orderedIds: string[],
): Promise<Folder[]> {
  return invoke<Folder[]>("note_folder_reorder", {
    repoRoot,
    scope,
    bucket,
    orderedIds,
  });
}

/** Delete a folder. Its pages are moved to the root (never deleted); child
 *  folders are promoted to the deleted folder's parent. Returns the ids of the
 *  pages that were moved to root. */
export function noteFolderDelete(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
): Promise<string[]> {
  return invoke<string[]>("note_folder_delete", { repoRoot, scope, bucket, id });
}

/** Move a page into a folder (id) or back to the root (null). */
export function noteSetFolder(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  pageId: string,
  folderId: string | null,
): Promise<Note> {
  return invoke<Note>("note_set_folder", {
    repoRoot,
    scope,
    bucket,
    pageId,
    folderId,
  });
}

/** Stable composite key for a page across scope/bucket boundaries. */
export function pageKey(s: {
  scope: NoteScope;
  bucket: string;
  id: string;
}): string {
  return `${s.scope}|${s.bucket}|${s.id}`;
}

/** Inverse of {@link pageKey}. */
export function parsePageKey(
  key: string,
): { scope: NoteScope; bucket: string; id: string } | null {
  const parts = key.split("|");
  if (parts.length < 3) return null;
  const [scope, bucket, ...rest] = parts;
  return {
    scope: scope as NoteScope,
    bucket,
    id: rest.join("|"),
  };
}

// ─── Page comments (PR/ticket-style threads) ─────────────────────────────
//
// A page's conversation lives in a sidecar JSON beside the page under
// `.aura/notes/<scope>/[bucket/]comments/<id>.json` (see
// `src-tauri/src/cmd_page_comments.rs`). These wrappers take flat camelCase
// keys to match the snake_case command names + the project's camelCase arg
// style — the same convention `notesArchive` / `notesSetParent` use.

export type PageComment = {
  id: string;
  author: string;
  body: string;
  created_at: string;
  /** Present (ISO ts) when the comment was resolved; absent while open. */
  resolved_at?: string | null;
};

/** Load a page's comment thread, oldest-first. */
export function pageCommentsList(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
): Promise<PageComment[]> {
  return invoke<PageComment[]>("page_comments_list", {
    repoRoot,
    scope,
    bucket,
    id,
  });
}

/** Append a comment and resolve with the persisted row. */
export function pageCommentsAdd(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  author: string,
  body: string,
): Promise<PageComment> {
  return invoke<PageComment>("page_comments_add", {
    repoRoot,
    scope,
    bucket,
    id,
    author,
    body,
  });
}

/** Toggle a comment's resolved state; returns the updated row. */
export function pageCommentsResolve(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  commentId: string,
  resolved: boolean,
): Promise<PageComment> {
  return invoke<PageComment>("page_comments_resolve", {
    repoRoot,
    scope,
    bucket,
    id,
    commentId,
    resolved,
  });
}

/** Delete a comment from a page's thread (idempotent). */
export function pageCommentsDelete(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
  commentId: string,
): Promise<void> {
  return invoke<void>("page_comments_delete", {
    repoRoot,
    scope,
    bucket,
    id,
    commentId,
  });
}
