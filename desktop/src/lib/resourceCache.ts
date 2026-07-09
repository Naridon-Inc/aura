// resourceCache — a tiny module-scoped cache for workpane data so that
// reopening Tasks / Pages (and any other panel that opts in) paints
// instantly from the last load instead of re-reading from disk on every
// open. SWR-style by convention: a caller seeds its state from peek() on
// open, kicks off a background refetch, then write()s the fresh bundle.
//
// Deliberately NOT react-query / SWR (no new dependency, and these
// panels load composite bundles — several api calls fanned out and
// merged — that don't map cleanly onto per-key query hooks). The store
// lives for the app session only; a full reload clears it. That's the
// right lifetime: it kills the "load again and again" flicker within a
// session without risking stale data surviving a relaunch.
//
// Keys are namespaced strings, e.g. `tasks:${repoRoot}` /
// `pages:${repoRoot}`. Values are whatever composite the caller stores.

type Entry<T> = { data: T; ts: number };

const store = new Map<string, Entry<unknown>>();

/** Last value cached under `key`, or undefined if never written. */
export function peekCache<T>(key: string): T | undefined {
  const e = store.get(key);
  return e ? (e.data as T) : undefined;
}

/** Replace the cached value for `key`, stamping it with the load time. */
export function writeCache<T>(key: string, data: T): void {
  store.set(key, { data, ts: Date.now() });
}

/** Drop a single key (e.g. after a mutation that the bundle can't patch). */
export function invalidateCache(key: string): void {
  store.delete(key);
}

/** Drop every key whose name starts with `prefix` (e.g. one repo root). */
export function invalidateCachePrefix(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/** Milliseconds since `key` was last written, or undefined if absent. */
export function cacheAge(key: string): number | undefined {
  const e = store.get(key);
  return e ? Date.now() - e.ts : undefined;
}

/** True when `key` has a cached value (i.e. a warm, instant-paint open). */
export function hasCache(key: string): boolean {
  return store.has(key);
}
