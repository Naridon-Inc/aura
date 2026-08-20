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
//
// One read, whatever the caller asked for. Six surfaces want this feed and each
// wants a different number of rows — the palette 400, the activity feed 200,
// the year-in-review everything — but the backend does the same expensive work
// regardless of the number: it unions the log across every branch tip (one
// `git show` per ref, serially) and pulls teammates' intents from the cloud
// over the network, and only truncates at the very end. Asking six times for
// six different row counts therefore costs six full reads to produce six
// prefixes of the same list. So there is a single read at the ceiling, and each
// caller slices the rows it wanted off the front — the backend returns them
// newest-first, so a slice is exactly what a smaller `limit` would have given.

import { api, type IntentRow } from "./api";

/** The most rows one read may return — `INTENT_ROW_CEILING` in
 *  `cmd_aura.rs`. Reading at the ceiling is what lets every caller be served
 *  from one read. */
const INTENT_READ_LIMIT = 5000;

/** How long a read stays good enough to hand to the next caller without going
 *  back to the backend.
 *
 *  This exists for the cloud pull. The branch-tip union already has an
 *  8-second TTL in the backend, but the network round-trip that folds in
 *  teammates' intents has no cache at any layer, so without this every surface
 *  that opens pays it again. Short enough that a newly logged intent shows up
 *  on the next visit; `invalidateIntentRows` is there for the cases that must
 *  not wait. */
const FRESH_MS = 10_000;

type Entry = { rows: IntentRow[]; readAt: number };

// repoRoot → last successfully-read rows and when we read them.
const cache = new Map<string, Entry>();
// repoRoot → in-flight read, so concurrent panes don't double-fetch.
const inflight = new Map<string, Promise<IntentRow[]>>();

/** Rows are newest-first, so the first `limit` of them is what a read with
 *  that limit would have returned.
 *
 *  Always a copy, including when the caller named no limit: the cached array is
 *  shared by every surface in the app, and handing one of them the array itself
 *  means a caller that sorts or truncates its own list silently rewrites what
 *  the next surface reads. */
function take(rows: IntentRow[], limit?: number): IntentRow[] {
  return rows.slice(0, limit);
}

/** Synchronous peek at the cached rows for a repo, if a read has ever landed.
 *  Surfaces use this to paint immediately before the background refresh.
 *  Ignores freshness on purpose — something true a minute ago beats a
 *  spinner. */
export function peekIntentRows(
  repoRoot: string,
  limit?: number,
): IntentRow[] | undefined {
  const entry = cache.get(repoRoot);
  return entry === undefined ? undefined : take(entry.rows, limit);
}

/** Read the recent history rows for a repo, sharing one read across callers.
 *  Serves a read from the last {@link FRESH_MS} without touching the backend;
 *  otherwise reads, and concurrent callers join the read already running.
 *  Rejects on a hard read failure (callers that already have cached rows
 *  should keep them and ignore the rejection). */
export function fetchIntentRows(
  repoRoot: string,
  limit?: number,
): Promise<IntentRow[]> {
  const entry = cache.get(repoRoot);
  if (entry !== undefined && Date.now() - entry.readAt < FRESH_MS) {
    return Promise.resolve(take(entry.rows, limit));
  }
  return refreshIntentRows(repoRoot, limit);
}

/** Read past the freshness window — for a surface that has just changed
 *  something and needs to see it. Still shares an in-flight read. */
export function refreshIntentRows(
  repoRoot: string,
  limit?: number,
): Promise<IntentRow[]> {
  const pending = inflight.get(repoRoot);
  if (pending) return pending.then((rows) => take(rows, limit));

  const promise = api
    .auraIntentRecent(repoRoot, INTENT_READ_LIMIT)
    .then((rows) => {
      // The log is append-only, so a fresh read is a superset of the prior
      // tail — replacing outright is safe.
      cache.set(repoRoot, { rows, readAt: Date.now() });
      inflight.delete(repoRoot);
      return rows;
    })
    .catch((e) => {
      inflight.delete(repoRoot);
      throw e;
    });
  inflight.set(repoRoot, promise);
  return promise.then((rows) => take(rows, limit));
}

/** Drop a repo's cached history so the next read goes cold (e.g. after a
 *  history-rewriting action). */
export function invalidateIntentRows(repoRoot: string): void {
  cache.delete(repoRoot);
}
