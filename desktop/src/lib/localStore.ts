// localStore — one budgeted door onto `localStorage`.
//
// WebKit gives an origin ~5 MB of localStorage and throws
// `QuotaExceededError` on the write that crosses it. Every caller in this
// app wrapped `setItem` in a bare `try {} catch {}`, so crossing the line
// was completely silent — and the writes that got dropped were not the
// ones you would choose to lose.
//
// Measured on this machine (2026-08-01), dev + prod webviews:
//
//     dev   5,429,466 bytes over 1,093 keys   (quota is 5,242,880)
//     prod  5,366,965 bytes over   637 keys
//
//     aura.pr.*                3,107,696 B  (795 keys)
//     aura.chat.*              1,967,735 B  ( 69 keys)
//     aura.workspaceSnapshot.*    50,332 B  ( 21 keys)
//
// A single `aura.pr.detail.cache.…#31` entry was 1,617,656 bytes — 31% of
// the whole origin budget spent on one PR diff that `gh` will happily hand
// back again. Meanwhile the per-workspace tab snapshots — the thing that
// remembers you had Claude Code open in `marrakesh` — are 2.4 KB each and
// were the writes being refused. That is the "switch worktrees and come
// back to an empty pane" bug: `saveSnapshot` threw, swallowed it, and the
// workspace rehydrated from a stale-or-absent slot.
//
// So the rule here is a priority, not a bigger try/catch:
//
//   • Caches are regenerable. They yield.
//   • Session state (which tabs are open, which agent you were talking to)
//     is not regenerable. It wins.
//
// `setDurable` therefore evicts caches to make room and retries, and
// `setCache` refuses to persist an entry so large it would evict its own
// neighbours. Both report success so a caller can tell "stored" from
// "dropped" instead of assuming.

/** Anything under `aura.` carrying a `.cache.` segment is regenerable —
 *  PR details, PR lists, PR comments, chat backlog. Naming a prefix list
 *  instead would rot the moment someone adds a cache. */
function isEvictable(key: string): boolean {
  return key.startsWith("aura.") && key.includes(".cache.");
}

/** WebKit bills key + value, both as UTF-16 code units. Close enough to
 *  the real accounting to rank entries and size an eviction. */
function cost(key: string, value: string): number {
  return key.length + value.length;
}

/** A cache entry larger than this is not worth an origin's whole budget.
 *  It stays in the module's in-memory map for the session; it just doesn't
 *  survive a relaunch. 128 KB fits every PR detail we measured except the
 *  handful of enormous diffs that caused the problem. */
const MAX_CACHE_ENTRY_BYTES = 128 * 1024;

/** Extra room to free beyond the pending write, so the next few writes
 *  don't each pay for their own eviction pass. */
const EVICTION_SLACK_BYTES = 256 * 1024;

function isQuotaError(e: unknown): boolean {
  // Safari/WebKit: DOMException code 22, name "QuotaExceededError".
  // Firefox uses 1014 / "NS_ERROR_DOM_QUOTA_REACHED". Some engines throw a
  // plain Error when storage is disabled entirely — treat those as quota
  // too; the recovery (free space, retry once) is harmless either way.
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; code?: unknown };
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22 ||
    err.code === 1014
  );
}

type Entry = { key: string; bytes: number };

/** Every evictable key with its byte cost, largest first. */
function evictableEntries(exceptKey: string): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === exceptKey || !isEvictable(key)) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    out.push({ key, bytes: cost(key, value) });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/** Drop the biggest regenerable entries until `needed` bytes are free.
 *  Biggest-first rather than oldest-first on purpose: one 1.6 MB PR diff
 *  costs the user nothing to refetch and buys back room for hundreds of
 *  small durable writes, where evicting by age would walk past it. */
function evict(needed: number, exceptKey: string): number {
  let freed = 0;
  for (const entry of evictableEntries(exceptKey)) {
    if (freed >= needed) break;
    try {
      localStorage.removeItem(entry.key);
      freed += entry.bytes;
    } catch {
      // Nothing actionable — keep going, another key may still free room.
    }
  }
  return freed;
}

/** Write session state that cannot be regenerated (workspace snapshots,
 *  open-tab lists, split layout). Evicts caches and retries if the origin
 *  is full. Returns whether the value is actually stored. */
export function setDurable(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (!isQuotaError(e)) return false;
  }
  if (evict(cost(key, value) + EVICTION_SLACK_BYTES, key) === 0) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Write a regenerable cache entry. Oversized entries are refused (and any
 *  stale copy dropped) so one blob can't own the origin's budget; a full
 *  origin evicts other caches and retries once. Returns whether the value
 *  is actually stored — `false` means "kept in memory only", not an error. */
export function setCache(key: string, value: string): boolean {
  if (cost(key, value) > MAX_CACHE_ENTRY_BYTES) {
    // A previously-written smaller copy would now be stale AND expensive.
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage disabled — nothing to drop */
    }
    return false;
  }
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (!isQuotaError(e)) return false;
  }
  if (evict(cost(key, value) + EVICTION_SLACK_BYTES, key) === 0) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Drop cache entries already over the per-entry cap. Existing installs are
 *  sitting on blobs written before this module existed — measured at 1.6 MB
 *  for a single PR — and lazy eviction only fires on the next write that
 *  fails, which is precisely the durable write we don't want to lose. Called
 *  once at boot so the budget starts honest. Returns bytes reclaimed. */
export function pruneOversizedCaches(): number {
  let freed = 0;
  for (const entry of evictableEntries("")) {
    if (entry.bytes <= MAX_CACHE_ENTRY_BYTES) break; // sorted desc
    try {
      localStorage.removeItem(entry.key);
      freed += entry.bytes;
    } catch {
      /* keep going */
    }
  }
  return freed;
}

/** Total billed bytes for this origin, and the evictable share of it.
 *  Exposed for diagnostics (doctor / a future storage readout) rather than
 *  guessing at a number that is measurable. */
export function storageUsage(): { totalBytes: number; evictableBytes: number } {
  let totalBytes = 0;
  let evictableBytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    const bytes = cost(key, value);
    totalBytes += bytes;
    if (isEvictable(key)) evictableBytes += bytes;
  }
  return { totalBytes, evictableBytes };
}
