// prDetailCache — Stage 8K. Stale-while-revalidate cache for
// `api.prDetail(repoRoot, prNumber)`. Without it, every PR open
// (including reopening a PR you just looked at) round-trips through
// `gh pr view --json …` + `gh pr diff` which together take 1–2s on a
// large repo. With this, reopening a recently-viewed PR is instant
// and a background refresh quietly updates the data if anything
// changed upstream.
//
// Mirrors prsCache.ts shape exactly so the two are easy to reason about
// together. Key = `${repoRoot}#${prNumber}`. Persisted to localStorage
// (not sessionStorage) so a PR you viewed survives an app restart, and
// getPrDetailCached hands back the last-known detail regardless of age —
// so reopening a PR never flashes "Loading PR…" once it has been seen,
// while SWR refreshes in the background. Same timing constants
// (30s fresh / 10m expiry) still gate the blocking-refetch path.

import { api, type PrDetail } from "./api";

const STALE_MS = 30_000; // 30s: served fresh without refetch
const EXPIRY_MS = 10 * 60_000; // 10m: beyond this, refetch blocking

type Entry = {
  data: PrDetail;
  fetchedAt: number;
  inflight?: Promise<PrDetail>;
};

const mem = new Map<string, Entry>();
const subs = new Map<string, Set<(detail: PrDetail) => void>>();

function key(repoRoot: string, prNumber: number): string {
  return `${repoRoot}#${prNumber}`;
}

function lsKey(k: string): string {
  return `aura.pr.detail.cache.${k}`;
}

function loadPersisted(k: string): Entry | null {
  try {
    const raw = localStorage.getItem(lsKey(k));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: PrDetail; fetchedAt: number };
    if (!parsed?.data || typeof parsed.fetchedAt !== "number") return null;
    return { data: parsed.data, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function savePersisted(k: string, entry: Entry): void {
  try {
    localStorage.setItem(
      lsKey(k),
      JSON.stringify({ data: entry.data, fetchedAt: entry.fetchedAt }),
    );
  } catch {
    // localStorage can be full / disabled — silently ignore.
  }
}

function notify(k: string, detail: PrDetail): void {
  const set = subs.get(k);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(detail);
    } catch (e) {
      console.error("prDetailCache subscriber failed", e);
    }
  }
}

async function refreshNow(
  repoRoot: string,
  prNumber: number,
): Promise<PrDetail> {
  const k = key(repoRoot, prNumber);
  const existing = mem.get(k);
  if (existing?.inflight) return existing.inflight;
  const p = api
    .prDetail(repoRoot, prNumber)
    .then((detail) => {
      const entry: Entry = { data: detail, fetchedAt: Date.now() };
      mem.set(k, entry);
      savePersisted(k, entry);
      notify(k, detail);
      return detail;
    })
    .finally(() => {
      const e = mem.get(k);
      if (e) e.inflight = undefined;
    });
  const cur = mem.get(k);
  if (cur) cur.inflight = p;
  else mem.set(k, { data: undefined as unknown as PrDetail, fetchedAt: 0, inflight: p });
  return p;
}

/** Get the last-known detail synchronously for an instant first paint.
 *  Returns whatever is cached regardless of age (SWR refreshes via
 *  fetchPrDetail). Returns null only when there is no real cached entry
 *  yet — no data, or a placeholder cold-fetch entry (fetchedAt === 0) —
 *  so "Loading PR…" shows once, not on every restart or 10-min idle. */
export function getPrDetailCached(
  repoRoot: string,
  prNumber: number,
): PrDetail | null {
  const k = key(repoRoot, prNumber);
  let entry = mem.get(k);
  if (!entry) {
    const persisted = loadPersisted(k);
    if (persisted) {
      mem.set(k, persisted);
      entry = persisted;
    }
  }
  if (!entry || !entry.data || entry.fetchedAt === 0) return null;
  return entry.data;
}

/** Fetch with stale-while-revalidate. Pair with `getPrDetailCached`
 *  for an instant first paint. */
export async function fetchPrDetail(
  repoRoot: string,
  prNumber: number,
): Promise<PrDetail> {
  const k = key(repoRoot, prNumber);
  let entry = mem.get(k);
  if (!entry) {
    const persisted = loadPersisted(k);
    if (persisted) {
      mem.set(k, persisted);
      entry = persisted;
    }
  }
  const now = Date.now();
  if (entry?.data && entry.fetchedAt > 0 && now - entry.fetchedAt < STALE_MS) {
    return entry.data;
  }
  if (entry?.data && entry.fetchedAt > 0 && now - entry.fetchedAt < EXPIRY_MS) {
    void refreshNow(repoRoot, prNumber);
    return entry.data;
  }
  return refreshNow(repoRoot, prNumber);
}

/** Force-refresh ignoring cache age. Used after mutations (approve,
 *  merge, label edit) so the next open sees the new state. */
export function invalidatePrDetail(
  repoRoot: string,
  prNumber: number,
): Promise<PrDetail> {
  return refreshNow(repoRoot, prNumber);
}

/** Subscribe to background refreshes for a specific PR. Callback
 *  fires every time the cache for that PR is updated. */
export function subscribePrDetail(
  repoRoot: string,
  prNumber: number,
  cb: (detail: PrDetail) => void,
): () => void {
  const k = key(repoRoot, prNumber);
  let set = subs.get(k);
  if (!set) {
    set = new Set();
    subs.set(k, set);
  }
  set.add(cb);
  return () => {
    const s = subs.get(k);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(k);
  };
}
