// resourceCache — a tiny module-scoped cache for workpane data so that
// reopening Tasks / Pages (and any other panel that opts in) paints
// instantly from the last load instead of re-reading from disk on every
// open. SWR-style by convention: a caller seeds its state from peek() on
// open, kicks off a background refetch, then write()s the fresh bundle.
//
// Deliberately NOT react-query / SWR (no new dependency, and these
// panels load composite bundles — several api calls fanned out and
// merged — that don't map cleanly onto per-key query hooks).
//
// Keys are namespaced strings, e.g. `tasks:${repoRoot}` /
// `pages:${repoRoot}`. Values are whatever composite the caller stores.
//
// ## How long an answer lives
//
// By default, for the app session: a full reload clears it. That kills the
// "load again and again" flicker within a session without risking stale data
// surviving a relaunch.
//
// A few answers cost seconds and describe this machine rather than an
// account: which coding agents are installed and their versions, say. Session
// lifetime means every start opens those panes on a spinner again. A key
// written with `persist` is also kept in localStorage under a versioned
// prefix, and a memory miss reads it back.
//
// ## Account-scoped keys
//
// Anything read from Aura Cloud belongs to the org the app is acting as. Such
// keys start with `cloud:` (ACCOUNT_SCOPE). When the org or the sign-in
// changes, every `cloud:` key is dropped at once and subscribers to
// onAccountScopeChanged hear about it, so no surface paints the previous org's
// list for the new one. Writes from reads that started before the change are
// refused (accountEpoch). `cloud:` keys are never persisted: the next start
// may be acting as someone else.

import { onOrgChanged } from "./cloudOrgs";

type Entry<T> = { data: T; ts: number };

const store = new Map<string, Entry<unknown>>();

/** Prefix of every key whose answer depends on the cloud account and org. */
export const ACCOUNT_SCOPE = "cloud:";

/** Bump when a persisted shape changes, so old entries are ignored. */
const PERSIST_PREFIX = "aura.cache.v1:";
/** A persisted answer bigger than this stays in memory only. */
const PERSIST_MAX_CHARS = 256 * 1024;

export function isAccountScoped(key: string): boolean {
  return key.startsWith(ACCOUNT_SCOPE);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readPersisted<T>(key: string): Entry<T> | undefined {
  if (isAccountScoped(key)) return undefined;
  try {
    const raw = storage()?.getItem(PERSIST_PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Entry<T>;
    return typeof parsed?.ts === "number" && "data" in parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writePersisted(key: string, entry: Entry<unknown>): void {
  if (isAccountScoped(key)) return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > PERSIST_MAX_CHARS) return;
    storage()?.setItem(PERSIST_PREFIX + key, raw);
  } catch {
    // Full or blocked storage: the memory copy still serves this session.
  }
}

function dropPersisted(match: (key: string) => boolean): void {
  const s = storage();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PERSIST_PREFIX) && match(k.slice(PERSIST_PREFIX.length))) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    // Nothing to drop if storage is unreadable.
  }
}

/** Entry for `key`: memory first, then what an earlier run persisted. */
function entryOf<T>(key: string): Entry<T> | undefined {
  const e = store.get(key) as Entry<T> | undefined;
  if (e) return e;
  const kept = readPersisted<T>(key);
  if (kept) store.set(key, kept);
  return kept;
}

// Surfaces showing a key, told when anyone writes it. One answer everywhere:
// "Look again" in one pane updates the agent list another pane is showing.
const watchers = new Map<string, Set<(data: unknown) => void>>();

/** Hear every write to `key`. Returns the unsubscribe. */
export function watchCache<T>(key: string, fn: (data: T) => void): () => void {
  let set = watchers.get(key);
  if (!set) {
    set = new Set();
    watchers.set(key, set);
  }
  const cb = fn as (data: unknown) => void;
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) watchers.delete(key);
  };
}

/** Last value cached under `key`, or undefined if never written. */
export function peekCache<T>(key: string): T | undefined {
  return entryOf<T>(key)?.data;
}

/** Replace the cached value for `key`, stamping it with the load time.
 *  `persist` keeps it across restarts too (never for `cloud:` keys). */
export function writeCache<T>(key: string, data: T, opts: { persist?: boolean } = {}): void {
  const entry = { data, ts: Date.now() };
  store.set(key, entry);
  if (opts.persist) writePersisted(key, entry);
  for (const fn of watchers.get(key) ?? []) fn(data);
}

/** Drop a single key (e.g. after a mutation that the bundle can't patch). */
export function invalidateCache(key: string): void {
  store.delete(key);
  dropPersisted((k) => k === key);
}

/** Drop every key whose name starts with `prefix` (e.g. one repo root). */
export function invalidateCachePrefix(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
  dropPersisted((k) => k.startsWith(prefix));
}

/** Milliseconds since `key` was last written, or undefined if absent. */
export function cacheAge(key: string): number | undefined {
  const e = entryOf(key);
  return e ? Date.now() - e.ts : undefined;
}

/** True when `key` has a cached value (i.e. a warm, instant-paint open). */
export function hasCache(key: string): boolean {
  return entryOf(key) !== undefined;
}

// ── Account changes ───────────────────────────────────────────────

let epoch = 0;
const scopeListeners = new Set<() => void>();

/** Which account world a read started in. A `cloud:` read that lands after
 *  the epoch moved on answers for an org nobody is looking at any more. */
export function accountEpoch(): number {
  return epoch;
}

/** Hear an org switch or sign-in change, *after* every `cloud:` answer has
 *  been dropped, so a re-read here can never be served the old org's list. */
export function onAccountScopeChanged(fn: () => void): () => void {
  scopeListeners.add(fn);
  return () => {
    scopeListeners.delete(fn);
  };
}

/** Forget everything read as the previous account. Wired to the org and
 *  sign-in events below; exported so a test can stand in for them. */
export function forgetAccountScoped(): void {
  epoch += 1;
  invalidateCachePrefix(ACCOUNT_SCOPE);
  for (const fn of [...scopeListeners]) fn();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  onOrgChanged(forgetAccountScoped);
}
