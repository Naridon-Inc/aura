// useCachedResource — the house stale-while-revalidate hook.
//
// Most panels in this app load the same way: mount, fire an api call, show a
// spinner, paint. Leave the panel and come back and they do it all again, so
// moving between surfaces costs a full round-trip every time even though the
// answer is usually the one already on screen a moment ago. This hook seeds
// from resourceCache so a revisit paints immediately, then revalidates in the
// background.
//
// Two rules it exists to keep, because both are easy to get wrong by hand:
//
//   1. A failed refresh never blanks what we already had. Dropping to empty
//      would replace a true (if slightly old) answer with a false one — "there
//      is nothing here" — which is the worst thing a panel can say.
//   2. A failed refresh is never silently passed off as current. The caller
//      gets `staleError` and can say so.
//
// Deliberately not react-query: no new dependency, and the store is a plain
// module-scoped Map that dies with the window, which is the right lifetime —
// it kills within-session reload flicker without letting stale data survive a
// relaunch.

import { useCallback, useEffect, useRef, useState } from "react";

import { peekCache, writeCache } from "./resourceCache";

export type ResourceState<T> = {
  /** The value on screen: fresh, or the last one we managed to read. */
  data: T | undefined;
  /** Nothing to show yet and a first read is in flight. */
  loading: boolean;
  /** Set when the latest read failed. `data`, if present, is a previous
   *  answer — old, but true when we got it. */
  staleError: string | null;
};

/** Opening state for `key`: whatever we cached last, or nothing. */
export function seedState<T>(key: string | null): ResourceState<T> {
  const cached = key === null ? undefined : peekCache<T>(key);
  return {
    data: cached,
    // A cached value means there is something real to paint, so this is not a
    // loading state even though a refresh is about to run.
    loading: cached === undefined && key !== null,
    staleError: null,
  };
}

/** A read came back. It is the current answer, and it clears any earlier
 *  failure — we are no longer showing something old. */
export function loadedState<T>(value: T): ResourceState<T> {
  return { data: value, loading: false, staleError: null };
}

/** A read failed. Keep whatever we were showing; say that it is not current. */
export function failedState<T>(
  prev: ResourceState<T>,
  message: string,
): ResourceState<T> {
  return { data: prev.data, loading: false, staleError: message };
}

// Reads currently in flight, keyed the same way as the cache.
//
// Panels do not mount one at a time. A surface with a rail and a detail pane
// asking the same question in the same tick used to fire two identical
// round-trips; the second one is pure waste, and on a slow read it is also a
// second chance to arrive out of order. lib/dirListCache.ts already had this
// property — the hook did not, so every panel converted to it lost it.
const inflight = new Map<string, Promise<unknown>>();

/** Start a read for `key` and register it so others can join. */
function freshRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const started = load().finally(() => {
    // Only clear our own entry: a forced reload may have replaced us while we
    // were still running, and that newer read has to stay joinable.
    if (inflight.get(key) === started) inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
}

/** Join the read already running for `key`, or start one. */
function sharedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  return existing ?? freshRead(key, load);
}

/** Exposed for tests — the two halves of the de-dup rule, without a DOM. */
export const readSharing = { freshRead, sharedRead };

type Options = {
  /** Skip the read entirely (e.g. the panel is closed). The cached value is
   *  still seeded, so reopening paints rather than flashing empty. */
  enabled?: boolean;
};

/**
 * Read `load()` under `key`, painting the last known value immediately.
 *
 * `key` is a namespaced string like `tasks:${repoRoot}`; pass `null` when
 * there is nothing to read yet (no project open) and nothing will run.
 *
 * `load` is called on mount and whenever `key` changes. Keep it stable with
 * `useCallback` or accept that a new identity re-runs the read — the same
 * contract every effect in this codebase has.
 */
export function useCachedResource<T>(
  key: string | null,
  load: () => Promise<T>,
  opts: Options = {},
): ResourceState<T> & { reload: () => Promise<void> } {
  const { enabled = true } = opts;
  const [state, setState] = useState<ResourceState<T>>(() => seedState<T>(key));

  // The load function changes identity on most renders (inline closures over
  // props). Reading it through a ref keeps `run` stable, so switching panels
  // doesn't re-fire the read on every parent render.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Which key the in-flight read belongs to. A read that lands after the key
  // moved on is answering a question nobody is asking any more.
  const forKey = useRef(key);
  forKey.current = key;

  const run = useCallback(async (mode: "join" | "fresh") => {
    const mine = forKey.current;
    if (mine === null) return;
    try {
      const value =
        mode === "join"
          ? await sharedRead(mine, loadRef.current)
          : await freshRead(mine, loadRef.current);
      if (forKey.current !== mine) return;
      writeCache(mine, value);
      setState(loadedState(value));
    } catch (e) {
      if (forKey.current !== mine) return;
      setState((prev) => failedState(prev, String(e)));
    }
  }, []);

  useEffect(() => {
    setState(seedState<T>(key));
    if (!enabled || key === null) return;
    void run("join");
  }, [key, enabled, run]);

  // Mounting joins a read already in flight; asking again on purpose does not.
  // `reload` is what a panel calls after it has changed something, and a read
  // that started before that change would answer with the old world.
  const reload = useCallback(() => run("fresh"), [run]);

  return { ...state, reload };
}
