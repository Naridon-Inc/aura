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
  const p = api
    .listDir(absPath)
    .then((entries) => {
      resolved.set(absPath, entries);
      inflight.delete(absPath);
      return entries;
    })
    .catch((e) => {
      inflight.delete(absPath);
      throw e;
    });
  inflight.set(absPath, p);
  return p;
}

/** Best-effort pre-fetch — populate the cache for `absPath` unless it is
 *  already warm or loading. Errors are swallowed; warming must never throw. */
export function warmDirList(absPath: string): void {
  if (resolved.has(absPath) || inflight.has(absPath)) return;
  void loadDirList(absPath).catch(() => {});
}
