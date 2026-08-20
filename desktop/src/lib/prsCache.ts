// prsCache — Stage 8I. In-memory + localStorage stale-while-revalidate
// cache for `api.prList(repoRoot)`. Without it every NavRail click on
// "PRs" + every PRDetailPane mount re-fetches the full PR list from
// GitHub via `gh pr list`, which takes 1–3s on large repos and means
// the Inbox flashes empty before populating.
//
// Behaviour:
//   - First call per repo: fetch fresh, populate cache, return promise.
//   - Subsequent calls within `STALE_MS`: return cached value AND skip
//     network. Subscribers get the cached array immediately.
//   - Calls after `STALE_MS` but before `EXPIRY_MS`: return cached
//     value immediately (stale) AND kick a background refresh whose
//     result is broadcast to subscribers.
//   - After `EXPIRY_MS`: treat as cold for the *fetch* path (refetch
//     blocking) — but the *paint* path (getPrListCached) still hands
//     back the last-known list so the UI never flashes a spinner when
//     it has anything to show. SWR corrects it within ~1s.
//
// Persisted to localStorage (not sessionStorage) so reopening the app —
// not just re-navigating within one session — paints the last-known PR
// list instantly. A merged/closed PR can show stale for the ~1s it
// takes the always-on background refresh to land, which beats a cold
// spinner on every launch.

import { api, type PrSummary } from "./api";
import { setCache } from "./localStore";

const STALE_MS = 30_000; // 30s: served fresh without refetch
const EXPIRY_MS = 10 * 60_000; // 10m: beyond this, refetch blocking

// Backoff: when `gh` fails (rate limit, auth, network) stop hammering it.
// Each consecutive failure doubles the cooldown during which refreshNow
// short-circuits — serving the cached list if we have one, else re-surfacing
// the last error. A success clears it. This is what keeps a rate-limited repo
// from re-firing `gh` on every NavRail click and digging the hole deeper.
const BACKOFF_BASE_MS = 5_000; // 5s after the first failure…
const BACKOFF_MAX_MS = 5 * 60_000; // …doubling up to 5m.

function backoffMs(failCount: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1));
}

type Entry = {
  data: PrSummary[];
  fetchedAt: number;
  inflight?: Promise<PrSummary[]>;
  failedAt?: number;
  failCount?: number;
  lastError?: unknown;
};

const mem = new Map<string, Entry>();
const subs = new Map<string, Set<(list: PrSummary[]) => void>>();

function lsKey(repoRoot: string): string {
  return `aura.pr.list.cache.${repoRoot}`;
}

function loadPersisted(repoRoot: string): Entry | null {
  try {
    const raw = localStorage.getItem(lsKey(repoRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: PrSummary[]; fetchedAt: number };
    if (!Array.isArray(parsed.data)) return null;
    return { data: parsed.data, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function savePersisted(repoRoot: string, entry: Entry): void {
  try {
    setCache(
      lsKey(repoRoot),
      JSON.stringify({ data: entry.data, fetchedAt: entry.fetchedAt }),
    );
  } catch {
    // localStorage can be full / disabled — silently ignore.
  }
}

function notify(repoRoot: string, list: PrSummary[]): void {
  const set = subs.get(repoRoot);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(list);
    } catch (e) {
      console.error("prsCache subscriber failed", e);
    }
  }
}

async function refreshNow(repoRoot: string): Promise<PrSummary[]> {
  const existing = mem.get(repoRoot);
  if (existing?.inflight) return existing.inflight;

  // Honour the backoff window from a recent failure: don't hit `gh` again
  // yet. Hand back the cached list if we have one; otherwise re-throw the
  // last error so the caller's banner still reflects *why* (rate limit etc.).
  if (existing?.failedAt != null) {
    const since = Date.now() - existing.failedAt;
    if (since < backoffMs(existing.failCount ?? 1)) {
      if (existing.data.length > 0) return existing.data;
      throw existing.lastError instanceof Error
        ? existing.lastError
        : new Error(String(existing.lastError ?? "GitHub request failed"));
    }
  }

  const p = api
    .prList(repoRoot)
    .then((list) => {
      // Success clears any prior failure/backoff state.
      const entry: Entry = { data: list, fetchedAt: Date.now() };
      mem.set(repoRoot, entry);
      savePersisted(repoRoot, entry);
      notify(repoRoot, list);
      return list;
    })
    .catch((e) => {
      const prev = mem.get(repoRoot) ?? { data: [], fetchedAt: 0 };
      mem.set(repoRoot, {
        ...prev,
        failedAt: Date.now(),
        failCount: (prev.failCount ?? 0) + 1,
        lastError: e,
      });
      throw e;
    })
    .finally(() => {
      const e = mem.get(repoRoot);
      if (e) e.inflight = undefined;
    });
  const cur = mem.get(repoRoot) ?? { data: [], fetchedAt: 0 };
  cur.inflight = p;
  mem.set(repoRoot, cur);
  return p;
}

/** Get the last-known list synchronously for an instant first paint.
 *  Returns whatever is cached regardless of age (stale-while-revalidate:
 *  the caller always pairs this with `fetchPrList`, which refreshes the
 *  data in the background). Returns null ONLY when there is no cached
 *  entry at all — i.e. the genuine first-ever load — so the loading
 *  spinner shows once, not on every restart or after a 10-minute idle. */
export function getPrListCached(repoRoot: string): PrSummary[] | null {
  let entry = mem.get(repoRoot);
  if (!entry) {
    const persisted = loadPersisted(repoRoot);
    if (persisted) {
      mem.set(repoRoot, persisted);
      entry = persisted;
    }
  }
  if (!entry) return null;
  return entry.data;
}

/** Fetch with stale-while-revalidate. Always returns a promise that
 *  resolves with the freshest data the cache can produce. If a stale
 *  cached value exists, callers can pair this with `getPrListCached`
 *  for an instant first paint. */
export async function fetchPrList(repoRoot: string): Promise<PrSummary[]> {
  let entry = mem.get(repoRoot);
  if (!entry) {
    const ss = loadPersisted(repoRoot);
    if (ss) {
      mem.set(repoRoot, ss);
      entry = ss;
    }
  }
  const now = Date.now();
  if (entry && now - entry.fetchedAt < STALE_MS) {
    return entry.data;
  }
  if (entry && now - entry.fetchedAt < EXPIRY_MS) {
    // Stale: kick background refresh, return cached. Swallow a background
    // failure — the cached list is what we're returning; the next foreground
    // fetch surfaces the error (and respects the backoff set here).
    void refreshNow(repoRoot).catch(() => {});
    return entry.data;
  }
  // Cold or expired: block.
  return refreshNow(repoRoot);
}

/** Force-refresh ignoring cache age. Used after mutations (label edit,
 *  approve, merge, comment) so other panes see the new state. */
export function invalidatePrList(repoRoot: string): Promise<PrSummary[]> {
  return refreshNow(repoRoot);
}

/** Subscribe to background refreshes for a repo. Callback fires every
 *  time the cache for that repoRoot is updated by any caller. */
export function subscribePrList(
  repoRoot: string,
  cb: (list: PrSummary[]) => void,
): () => void {
  let set = subs.get(repoRoot);
  if (!set) {
    set = new Set();
    subs.set(repoRoot, set);
  }
  set.add(cb);
  return () => {
    const s = subs.get(repoRoot);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(repoRoot);
  };
}

/** The pull request a branch is currently *about*, picked out of the cached
 *  list. Prefers the open one, then the most recently updated.
 *
 *  Both the review header and the Checks panel used to write this as a bare
 *  `prs.find((p) => p.head_ref === branch)`. The fetch behind this cache asks
 *  `gh` for `--state all`, so a branch carrying a superseded closed PR *and* a
 *  live open one resolved to whichever GitHub happened to return first: the
 *  Checks tab could open on a closed PR's title and description, offer to
 *  update it, and report "PR closed without merging" while the real, open pull
 *  request for that same branch sat in the list right below. */
export function pickBranchPr(
  prs: PrSummary[],
  branch: string | null,
): PrSummary | null {
  if (!branch) return null;
  const mine = prs.filter((p) => p.head_ref === branch);
  const open = mine.find((p) => p.state.toLowerCase() === "open");
  if (open) return open;
  // No open PR on this branch — show the newest of what's left rather than the
  // arbitrary first, so a re-opened-then-superseded branch reads in real order.
  return (
    mine.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ??
    null
  );
}

/** Patch one PR in the cached list (for in-place updates after a label
 *  edit etc. without a full refetch). No-op if the PR isn't cached. */
export function patchCachedPr(
  repoRoot: string,
  prNumber: number,
  patch: Partial<PrSummary>,
): void {
  const entry = mem.get(repoRoot) ?? loadPersisted(repoRoot);
  if (!entry) return;
  let changed = false;
  const next = entry.data.map((p) => {
    if (p.number !== prNumber) return p;
    changed = true;
    return { ...p, ...patch };
  });
  if (!changed) return;
  const updated: Entry = { data: next, fetchedAt: entry.fetchedAt };
  mem.set(repoRoot, updated);
  savePersisted(repoRoot, updated);
  notify(repoRoot, next);
}
