// Warm, stale-while-revalidate cache for @-mention directory listings.
//
// The Manager composer's `@file` popup lists a directory via `api.listDir`.
// Without a cache the first `@` a user types pays a fresh IPC round-trip before
// anything paints — the "first-@ latency" the composer warms away by
// pre-fetching the workspace root on idle when it mounts. This module holds the
// last-known listing per absolute dir path so a warmed path paints instantly;
// callers still revalidate (see `loadDirList`) so the popup can't go stale.
//
// Mirrors the module-level Map style of lib/sessionDataCache.ts and
// lib/changeNoteCache.ts — window-lifetime, no eviction (listings are small and
// the set of dirs a user @-browses in a session is modest).

import { api } from "./api";
import type { DirEntry } from "./api";

// Last resolved listing per absolute dir path — the instant-paint source.
const resolved = new Map<string, DirEntry[]>();
// In-flight fetches, so concurrent callers (idle warm + the first `@`) share a
// single IPC round-trip instead of racing two.
const inflight = new Map<string, Promise<DirEntry[]>>();
// Bumped whenever a caller declares the directory changed under us (see
// `reloadDirList`). A read that was already running when that happened is
// describing the folder as it was before; it still resolves for whoever is
// awaiting it, but it must not be written to `resolved` — that map is what
// `peekDirList` paints from, and a slow pre-change read landing after a fast
// post-change one would leave the tree showing the older of the two.
const epoch = new Map<string, number>();

/** Synchronously read the last-known listing for a dir, or `undefined` if it
 *  was never fetched/warmed. Lets a caller paint immediately before it
 *  revalidates via {@link loadDirList}. */
export function peekDirList(absPath: string): DirEntry[] | undefined {
  return resolved.get(absPath);
}

/** Fetch a directory listing, deduping concurrent reads and caching the
 *  resolved payload for later instant paints. Always hits the backend when no
 *  fetch is already in flight, so callers that revalidate stay fresh. */
export function loadDirList(absPath: string): Promise<DirEntry[]> {
  const existing = inflight.get(absPath);
  if (existing) return existing;
  const mine = epoch.get(absPath) ?? 0;
  const p = api
    .listDir(absPath)
    .then((entries) => {
      // Only store this if the folder hasn't been declared changed since we
      // started. Within one epoch there is at most one read in flight per path
      // — a second caller joins the first — so passing this check also means
      // the in-flight slot is ours to clear.
      if ((epoch.get(absPath) ?? 0) === mine) {
        resolved.set(absPath, entries);
        inflight.delete(absPath);
      }
      return entries;
    })
    .catch((e) => {
      // Here the identity check is load-bearing: a read that fails *after*
      // being superseded would otherwise clear the replacement's slot, and the
      // next caller would start a third read of a directory already being read.
      if (inflight.get(absPath) === p) inflight.delete(absPath);
      throw e;
    });
  inflight.set(absPath, p);
  return p;
}

/** Read `absPath` again from scratch, ignoring any read already in flight.
 *
 *  For the caller that just changed the directory — created a file, renamed
 *  one, deleted one — and is re-listing to show the result. {@link loadDirList}
 *  would hand it whichever read is already running, and a read that started
 *  before the write describes the folder without the change in it. The user
 *  then sees the file they just made missing, which is indistinguishable from
 *  the create having failed. */
export function reloadDirList(absPath: string): Promise<DirEntry[]> {
  epoch.set(absPath, (epoch.get(absPath) ?? 0) + 1);
  inflight.delete(absPath);
  return loadDirList(absPath);
}

/** Best-effort pre-fetch — populate the cache for `absPath` unless it is
 *  already warm or loading. Errors are swallowed; warming must never throw. */
export function warmDirList(absPath: string): void {
  if (resolved.has(absPath) || inflight.has(absPath)) return;
  void loadDirList(absPath).catch(() => {});
}
