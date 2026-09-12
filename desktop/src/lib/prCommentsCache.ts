// prCommentsCache — Stage 8K. Stale-while-revalidate cache for
// `api.prCommentsList(repoRoot, prNumber)`. Same shape as
// prDetailCache; PR threads update independently of the PR metadata
// (someone replies on a thread without touching the PR), so they
// deserve their own cache key + invalidation surface. Persisted to
// localStorage and paint-stale-regardless-of-age like prDetailCache, so
// the Conversation/threads don't re-flash empty on restart; SWR (15s
// fresh window) refreshes in the background.

//
// AURA-1307: keyed by PLACE (`placeScope`), not by root alone — the same
// local root standing in a machine is a different repo's threads. `gh` still
// runs here; on a machine it is told the repo by name (`remoteRepoFor`).

import { api, type PrComment } from "./api";
import { setCache } from "./localStore";
import { placeScope } from "./place/workApi";
import { remoteRepoFor } from "./prRepo";

const STALE_MS = 15_000; // 15s: comments move faster than detail
const EXPIRY_MS = 10 * 60_000;

type Entry = {
  data: PrComment[];
  fetchedAt: number;
  inflight?: Promise<PrComment[]>;
};

const mem = new Map<string, Entry>();
const subs = new Map<string, Set<(list: PrComment[]) => void>>();

function key(repoRoot: string, prNumber: number): string {
  return `${placeScope(repoRoot)}#${prNumber}`;
}

function lsKey(k: string): string {
  return `aura.pr.comments.cache.${k}`;
}

function loadPersisted(k: string): Entry | null {
  try {
    const raw = localStorage.getItem(lsKey(k));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: PrComment[]; fetchedAt: number };
    if (!Array.isArray(parsed?.data)) return null;
    return { data: parsed.data, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function savePersisted(k: string, entry: Entry): void {
  try {
    setCache(
      lsKey(k),
      JSON.stringify({ data: entry.data, fetchedAt: entry.fetchedAt }),
    );
  } catch {
    // ignore
  }
}

function notify(k: string, list: PrComment[]): void {
  const set = subs.get(k);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(list);
    } catch (e) {
      console.error("prCommentsCache subscriber failed", e);
    }
  }
}

async function refreshNow(
  repoRoot: string,
  prNumber: number,
): Promise<PrComment[]> {
  const k = key(repoRoot, prNumber);
  const existing = mem.get(k);
  if (existing?.inflight) return existing.inflight;
  const p = remoteRepoFor(repoRoot)
    .then((remoteRepo) => api.prCommentsList(repoRoot, prNumber, remoteRepo))
    .then((list) => {
      const entry: Entry = { data: list, fetchedAt: Date.now() };
      mem.set(k, entry);
      savePersisted(k, entry);
      notify(k, list);
      return list;
    })
    .finally(() => {
      const e = mem.get(k);
      if (e) e.inflight = undefined;
    });
  const cur = mem.get(k) ?? { data: [], fetchedAt: 0 };
  cur.inflight = p;
  mem.set(k, cur);
  return p;
}

export function getPrCommentsCached(
  repoRoot: string,
  prNumber: number,
): PrComment[] | null {
  const k = key(repoRoot, prNumber);
  let entry = mem.get(k);
  if (!entry) {
    const persisted = loadPersisted(k);
    if (persisted) {
      mem.set(k, persisted);
      entry = persisted;
    }
  }
  // Last-known regardless of age (SWR refreshes); null only for a
  // placeholder cold-fetch entry so threads never re-flash empty.
  if (!entry || entry.fetchedAt === 0) return null;
  return entry.data;
}

export async function fetchPrComments(
  repoRoot: string,
  prNumber: number,
): Promise<PrComment[]> {
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
  if (entry && entry.fetchedAt > 0 && now - entry.fetchedAt < STALE_MS) {
    return entry.data;
  }
  if (entry && entry.fetchedAt > 0 && now - entry.fetchedAt < EXPIRY_MS) {
    void refreshNow(repoRoot, prNumber);
    return entry.data;
  }
  return refreshNow(repoRoot, prNumber);
}

export function invalidatePrComments(
  repoRoot: string,
  prNumber: number,
): Promise<PrComment[]> {
  return refreshNow(repoRoot, prNumber);
}

export function subscribePrComments(
  repoRoot: string,
  prNumber: number,
  cb: (list: PrComment[]) => void,
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
