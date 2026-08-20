// chatCache — SWR-style localStorage cache for CommsPanel `msgs` so a
// fresh app boot or repo switch paints the last conversation
// immediately instead of leaving the panel blank until each per-channel
// `api.chatList` round-trip resolves.
//
// Cache shape (per key):
//   { v: 1, ts: <writeTimeMs>, msgs: Msg[] }
//
// We cap each entry at MAX_PER_CONV messages. That bounds the message
// COUNT, not the byte size, and the estimate that followed it here — "a 5KB
// ceiling per channel" — did not survive contact: measured on a real install,
// 51 chat cache keys held 1,967,735 bytes, one channel alone 761,234. Agent
// transcripts posted into a channel are long. So the byte ceiling now lives
// in `setCache`, which refuses an oversized entry outright rather than
// letting one channel spend the origin's budget. The hot ring of recent
// messages is what users want on first paint; older history can keep
// streaming in from the live `chatList` round-trip without blocking.

import { setCache } from "./localStore";

const VERSION = 1;
const PREFIX = "aura.chat.cache.v1::";
const MAX_PER_CONV = 100;

type CachedMsg = {
  id: string;
  ts: number;
  sender: string;
  body: string;
  fromMe: boolean;
  kind: "msg" | "system" | "activity";
  mentions?: string[];
  thread_parent?: string;
  is_agent?: boolean;
  pinned?: boolean;
  delivery_status?: "pending" | "delivered" | "failed";
  read_at?: number;
  seq?: number;
  activity?: unknown;
};

type Envelope = { v: number; ts: number; msgs: CachedMsg[] };

function key(repoRoot: string, convId: string): string {
  return `${PREFIX}${repoRoot}::${convId}`;
}

export function loadCachedMsgs<M extends CachedMsg>(
  repoRoot: string,
  convId: string,
): M[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key(repoRoot, convId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Envelope;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.msgs)) {
      return [];
    }
    return parsed.msgs as M[];
  } catch {
    return [];
  }
}

export function saveCachedMsgs<M extends CachedMsg>(
  repoRoot: string,
  convId: string,
  msgs: M[],
): void {
  if (typeof localStorage === "undefined") return;
  try {
    // Keep the tail — most-recent N — since that's what users see
    // first on open. Optimistic-pending rows are kept too; they'll
    // get reconciled by the next chatList merge.
    const tail = msgs.slice(-MAX_PER_CONV);
    const envelope: Envelope = { v: VERSION, ts: Date.now(), msgs: tail };
    setCache(key(repoRoot, convId), JSON.stringify(envelope));
  } catch {
    // QuotaExceeded: best-effort drop. The next save attempt will
    // retry; meanwhile the in-memory list is still authoritative.
  }
}

/** Hydrate the initial `Record<convId, Msg[]>` snapshot synchronously
 *  for every known conv id under a repo. Reads localStorage once
 *  per id; missing/corrupt entries map to []. */
export function loadCachedMsgsBatch<M extends CachedMsg>(
  repoRoot: string,
  convIds: readonly string[],
): Record<string, M[]> {
  const out: Record<string, M[]> = {};
  for (const id of convIds) {
    const cached = loadCachedMsgs<M>(repoRoot, id);
    if (cached.length > 0) out[id] = cached;
  }
  return out;
}

/** Scan every cache entry under a repo and return the full
 *  `Record<convId, Msg[]>` snapshot. Used to hydrate CommsPanel's
 *  `msgs` state synchronously on mount or repo switch so the first
 *  paint isn't empty while the per-channel `chatList` round-trips
 *  resolve one by one. */
export function loadCachedAllForRepo<M extends CachedMsg>(
  repoRoot: string,
): Record<string, M[]> {
  if (typeof localStorage === "undefined") return {};
  const out: Record<string, M[]> = {};
  const prefix = `${PREFIX}${repoRoot}::`;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const convId = k.slice(prefix.length);
    const cached = loadCachedMsgs<M>(repoRoot, convId);
    if (cached.length > 0) out[convId] = cached;
  }
  return out;
}

/** Drop every cached entry for a repo. Used when leaving a repo so a
 *  stale cache from a deleted/renamed channel can't leak forward. */
export function purgeCachedRepo(repoRoot: string): void {
  if (typeof localStorage === "undefined") return;
  const prefix = `${PREFIX}${repoRoot}::`;
  const drops: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) drops.push(k);
  }
  for (const k of drops) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
