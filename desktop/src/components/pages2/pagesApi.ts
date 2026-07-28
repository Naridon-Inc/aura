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

// ─── In-memory cache ───────────────────────────────────────────────────────
//
// Pages used to reload from zero on every open — each `notesRead` hit the
// backend fresh, and leaving + re-entering the Pages surface wiped the list so
// it re-listed from scratch. These module-level caches survive surface
// remounts (they live on the module, not in React state), so re-opening a page
// paints instantly from memory while a background read revalidates (SWR), and
// returning to Pages shows the last-known list immediately. Keyed by repoRoot
// so two projects never bleed into each other.

const noteCache = new Map<string, Note>();
const listCache = new Map<string, NoteSummary[]>();

function noteCacheKey(
  repoRoot: string,
  scope: string,
  bucket: string,
  id: string,
): string {
  return `${repoRoot}::${scope}|${bucket}|${id}`;
}

// ─── Disk-backed persistence (survives an app relaunch) ─────────────────────
//
// The maps above warm within a session but reset on every app launch, so the
// first open of a page after a restart pays a full backend read — that's the
// "opens fresh every time" the Pages surface shows right after a relaunch. We
// mirror the caches into localStorage under an `aura.pages2.*` namespace (only
// ever our own keys — never `clear()` or another surface's state), so a
// relaunch is warm: the list paints instantly and recently-opened pages open
// from disk while a background read revalidates. Note bodies are bounded by a
// small LRU so the localStorage quota can't run away.

const LS_PREFIX = "aura.pages2.";
const lsListKey = (repoRoot: string) => `${LS_PREFIX}list:${repoRoot}`;
const lsNoteKey = (cacheKey: string) => `${LS_PREFIX}note:${cacheKey}`;
const lsLastKey = (repoRoot: string) => `${LS_PREFIX}lastopen:${repoRoot}`;
const LS_LRU = `${LS_PREFIX}lru`;
const NOTE_LRU_CAP = 40;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // private mode / quota — degrade to in-memory only
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readLru(): string[] {
  const raw = lsGet(LS_LRU);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

// Persist one note body, moving it to the front of the LRU and evicting the
// oldest past the cap (and again if a quota error is hit).
function persistNote(cacheKey: string, note: Note): void {
  const order = readLru().filter((k) => k !== cacheKey);
  order.unshift(cacheKey);
  while (order.length > NOTE_LRU_CAP) {
    const evicted = order.pop();
    if (evicted) lsRemove(lsNoteKey(evicted));
  }
  const payload = JSON.stringify(note);
  if (!lsSet(lsNoteKey(cacheKey), payload)) {
    // Quota — drop the oldest handful and retry once.
    for (let i = 0; i < 5 && order.length > 1; i++) {
      const evicted = order.pop();
      if (evicted) lsRemove(lsNoteKey(evicted));
    }
    lsSet(lsNoteKey(cacheKey), payload);
  }
  lsSet(LS_LRU, JSON.stringify(order));
}

/** Last-known body+frontmatter for a page — memory first, then the disk mirror
 *  (promoted back into memory on a hit). Callers paint this instantly, then
 *  revalidate via {@link notesRead}. */
export function cachedNote(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
): Note | undefined {
  const key = noteCacheKey(repoRoot, scope, bucket, id);
  const mem = noteCache.get(key);
  if (mem) return mem;
  const raw = lsGet(lsNoteKey(key));
  if (raw) {
    try {
      const note = JSON.parse(raw) as Note;
      noteCache.set(key, note); // promote so the next hit is memory-fast
      return note;
    } catch {
      lsRemove(lsNoteKey(key)); // corrupt entry — drop it
    }
  }
  return undefined;
}

/** Seed the note cache from a page the caller already holds (e.g. a freshly
 *  created page) so the next open is a cache hit — in memory and on disk. */
export function putCachedNote(repoRoot: string, note: Note): void {
  const key = noteCacheKey(repoRoot, note.scope, note.bucket, note.id);
  noteCache.set(key, note);
  persistNote(key, note);
}

/** Last-known summary list for a repo — memory first, then the disk mirror.
 *  Lets the surface render the tree before the fresh list lands, even on the
 *  first open after a relaunch. */
export function cachedList(repoRoot: string): NoteSummary[] | undefined {
  const mem = listCache.get(repoRoot);
  if (mem) return mem;
  const raw = lsGet(lsListKey(repoRoot));
  if (raw) {
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) {
        listCache.set(repoRoot, rows as NoteSummary[]);
        return rows as NoteSummary[];
      }
    } catch {
      lsRemove(lsListKey(repoRoot));
    }
  }
  return undefined;
}

/** The page the reader last had open in a repo (its {@link pageKey}), so the
 *  surface can reopen where they left off instead of a blank editor. Null when
 *  they explicitly closed the last page or never opened one. */
export function lastOpenPageKey(repoRoot: string): string | null {
  return lsGet(lsLastKey(repoRoot));
}

/** Remember (or, with null, forget) the last-open page for a repo. */
export function setLastOpenPageKey(repoRoot: string, key: string | null): void {
  if (key) lsSet(lsLastKey(repoRoot), key);
  else lsRemove(lsLastKey(repoRoot));
}

/** List page summaries for a repo. Populates the list cache on success. */
export function notesList(input: NotesListInput): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("notes_list", {
    input: {
      repo_root: input.repoRoot,
      scope: input.scope ?? null,
      bucket: input.bucket ?? null,
    },
  }).then((rows) => {
    // Only the unfiltered (whole-repo) list is a faithful cache key; a
    // scope/bucket-narrowed list would poison the repo-wide entry.
    if (input.scope == null && input.bucket == null) {
      listCache.set(input.repoRoot, rows);
      lsSet(lsListKey(input.repoRoot), JSON.stringify(rows));
    }
    return rows;
  });
}

/** Read one page's frontmatter + body. Populates the note cache on success. */
export function notesRead(
  repoRoot: string,
  scope: NoteScope,
  bucket: string,
  id: string,
): Promise<Note> {
  return invoke<Note>("notes_read", {
    input: { repo_root: repoRoot, scope, bucket, id },
  }).then((note) => {
    putCachedNote(repoRoot, note);
    return note;
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
  }).then((note) => {
    // Keep the cache in step with the write so a re-open after a save is a hit
    // that reflects the just-saved body, never a stale one.
    putCachedNote(input.repoRoot, note);
    return note;
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
  }).then(() => {
    // Drop the cached copy (memory + disk + LRU) so a re-open can't resurrect a
    // deleted page.
    const key = noteCacheKey(repoRoot, scope, bucket, id);
    noteCache.delete(key);
    lsRemove(lsNoteKey(key));
    lsSet(LS_LRU, JSON.stringify(readLru().filter((k) => k !== key)));
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
  }).then((note) => {
    putCachedNote(repoRoot, note);
    return note;
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
