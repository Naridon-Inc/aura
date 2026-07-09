// Shared per-session caches for the Trace session-detail surfaces, so a session
// you've already opened re-renders instantly instead of re-shelling its
// transcript and per-file diffs every time you reopen the row or flip back to a
// tab. (The SessionDetailPane mounts as a fullscreen overlay per row and its
// tabs conditionally mount their bodies, so without this every reopen — and
// every Summary↔Transcript↔Changes toggle — refetched from scratch.)
//
// Mirrors lib/changeNoteCache.ts: a module-level Map<key, Promise<T>>
// deduplicates concurrent reads, persists resolved payloads for the window's
// lifetime, and evicts a rejected promise so the next caller retries instead of
// inheriting a dead one.
//
// Safe to cache: a transcript JSONL read (a past session's file is stable for
// review) and a committed file diff (`git show <sha>` is immutable — the whole
// point of a "previous session" is that it already landed). A working-tree diff
// (no commit sha) is a live/manual claim that can still change as the file is
// edited, so we deliberately DON'T cache that path — it reads fresh every time,
// exactly as before — and there's nothing stale to invalidate.

import { api } from "./api";
import type { IntentChangesetFile, StreamEvent } from "./api";

// ── transcript events ─────────────────────────────────────────────────
const transcriptCache = new Map<string, Promise<StreamEvent[]>>();

/** Which on-disk store a transcript replays from. `"claude"` reads a Claude
 *  Code JSONL by `file_path`; `"manager"` replays a native Aura chat session
 *  (`~/.aura/manager-sessions/<id>.json`) by its session id. Both reduce to the
 *  same {@link StreamEvent} stream the renderer consumes — the source only
 *  selects the loader (and namespaces the cache key so a manager id can't
 *  collide with a JSONL path). */
export type TranscriptSource = "claude" | "manager";

/** Fetch (or reuse) a session's transcript events. Keyed by source + ref +
 *  limit so a wider re-read can't collide with a narrower one and a manager
 *  session id can never collide with a Claude file path. `ref` is the JSONL
 *  `file_path` for `"claude"` and the manager session id for `"manager"`. */
export function loadSessionEvents(
  ref: string,
  limit = 500,
  source: TranscriptSource = "claude",
): Promise<StreamEvent[]> {
  const key = `${source}#${ref}#${limit}`;
  let p = transcriptCache.get(key);
  if (!p) {
    p =
      source === "manager"
        ? api.managerLoadTranscript(ref)
        : api.claudeLoadSession(ref, limit);
    p.catch(() => transcriptCache.delete(key));
    transcriptCache.set(key, p);
  }
  return p;
}

// ── committed per-file diffs ──────────────────────────────────────────
// Only committed (commit-sha) diffs are cached — they're immutable. A
// working-tree claim is read live every time (no cache entry), so it can never
// go stale.
const diffCache = new Map<string, Promise<string>>();

/** Fetch (or reuse) the rendered diff for one changeset file — `git show <sha>
 *  -- <path>` for a committed run (cached on the immutable sha), else a live
 *  `git diff HEAD -- <path>` for a working-tree claim (never cached). Matches
 *  the selection logic DiffPane used inline.
 *
 *  `sinceBase` (worktrees only): for a working-tree claim, render the file's
 *  full change from the worktree's fork base → working tree (committed AND
 *  uncommitted) instead of just vs HEAD. A committed-sha file always shows that
 *  exact commit's patch regardless — `sinceBase` only widens the live path. */
export function loadFileDiff(
  repoRoot: string,
  file: IntentChangesetFile,
  sinceBase = false,
): Promise<string> {
  // Committed run — the patch is immutable, so cache it on the sha.
  if (file.commit) {
    const key = `${repoRoot}@${file.commit}@${file.path}`;
    let p = diffCache.get(key);
    if (!p) {
      p = api.gitDiffAtCommit(repoRoot, file.commit, file.path);
      p.catch(() => diffCache.delete(key));
      diffCache.set(key, p);
    }
    return p;
  }
  // Native Aura chat session — diff the file's current state against the
  // session's start baseline (`git diff <base> -- <path>`). Read fresh, don't
  // cache: the working tree can still move (the session may be live), exactly
  // like the plain working-tree path below.
  if (file.base) {
    return api.gitDiffBase(repoRoot, file.base, file.path);
  }
  // Working-tree claim — read fresh, don't cache (the file can still change).
  return api.gitDiff(repoRoot, file.path, sinceBase);
}
