// intentCache — a per-repo, in-memory cache of the project's history rows
// (`.aura/intent_log.jsonl` via `auraIntentRecent`).
//
// Why: reading the whole history can take seconds on a long-lived repo (the
// engine occasionally saturates its async runtime), so re-opening the Timeline
// — or any surface that reads the same feed — meant staring at "Reading the
// project's history…" every single time. But the intent log is append-only:
// the older rows never change, only the recent tail grows. So we keep the last
// read in module scope and paint it INSTANTLY on the next open, then refresh in
// the background to pick up anything new. Cold first-open still does the real
// read (and shows the loader); every open after that is immediate.
//
// This mirrors the atlasHover cache shape (one shared read per repo, in-flight
// dedupe) so the two read-heavy surfaces behave consistently.

import { api, type IntentRow } from "./api";

// repoRoot → last successfully-read rows.
const cache = new Map<string, IntentRow[]>();
// repoRoot → in-flight read, so concurrent panes don't double-fetch.
const inflight = new Map<string, Promise<IntentRow[]>>();

/** Synchronous peek at the cached rows for a repo, if a read has ever landed.
 *  Surfaces use this to paint immediately before the background refresh. */
export function peekIntentRows(repoRoot: string): IntentRow[] | undefined {
  return cache.get(repoRoot);
}

/** Read the recent history rows for a repo, caching the result. Concurrent
 *  callers share one in-flight read. On success the cache is replaced — the log
 *  is append-only, so a fresh read is a superset of the prior tail. Rejects on
 *  a hard read failure (callers that already have cached rows should keep them
 *  and ignore the rejection). */
export function fetchIntentRows(
  repoRoot: string,
  limit = 4000,
): Promise<IntentRow[]> {
  const pending = inflight.get(repoRoot);
  if (pending) return pending;

  const promise = api
    .auraIntentRecent(repoRoot, limit)
    .then((rows) => {
      cache.set(repoRoot, rows);
      inflight.delete(repoRoot);
      return rows;
    })
    .catch((e) => {
      inflight.delete(repoRoot);
      throw e;
    });
  inflight.set(repoRoot, promise);
  return promise;
}

/** Drop a repo's cached history so the next read goes cold (e.g. after a
 *  history-rewriting action). */
export function invalidateIntentRows(repoRoot: string): void {
  cache.delete(repoRoot);
}
