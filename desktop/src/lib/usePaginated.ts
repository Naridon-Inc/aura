// Cursor-paginated list hook. The backend returns `{ entries, has_more,
// oldest_ts }`; this hook keeps a flat list of all loaded entries plus
// a `loadMore()` callback that resumes from the cursor. Reset semantics:
// changing any of the `dependencies` resets the page state.
//
// The paired `useInfiniteSentinel` returns a ref that — when scrolled
// into view — triggers `loadMore()`. Stick it on the last DOM node of
// the rendered list (or directly above an "end" marker).

import { useCallback, useEffect, useRef, useState } from "react";

export type Page<T> = {
  entries: T[];
  has_more: boolean;
  oldest_ts: number;
};

type FetchPage<T> = (cursor: number | undefined) => Promise<Page<T>>;

export type Paginated<T> = {
  entries: T[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reset: () => void;
};

/**
 * Generic cursor-paginated list. `fetchPage(cursor)` is called with
 * `undefined` for the first page and `oldest_ts` of the last page for
 * subsequent calls. Re-runs the first page whenever any item in
 * `dependencies` changes.
 */
export function usePaginated<T>(
  fetchPage: FetchPage<T>,
  dependencies: ReadonlyArray<unknown>,
): Paginated<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<number | undefined>(undefined);
  // Bumped on every reset so a stale fetch can't clobber a fresh page.
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    cursor.current = undefined;
    setEntries([]);
    setHasMore(true);
    setLoading(false);
  }, []);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    const myGen = generation.current;
    setLoading(true);
    try {
      const page = await fetchPage(cursor.current);
      if (generation.current !== myGen) return; // stale, drop
      setEntries((prev) => [...prev, ...page.entries]);
      setHasMore(page.has_more);
      cursor.current = page.oldest_ts;
    } finally {
      if (generation.current === myGen) {
        setLoading(false);
      }
    }
  }, [fetchPage, hasMore, loading]);

  // Reset + load first page when deps change.
  useEffect(() => {
    reset();
    void loadMore();
    // We intentionally only depend on the user-supplied `dependencies` —
    // `loadMore` and `reset` are stable callbacks above, and re-running
    // this effect on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return { entries, loading, hasMore, loadMore, reset };
}

/**
 * Returns a ref that fires `onIntersect` when its element scrolls into
 * the viewport (or scroll container). Use as a sentinel at the end of a
 * virtualized list to drive infinite scroll.
 */
export function useInfiniteSentinel<E extends Element>(
  onIntersect: () => void,
  // Optional scroll container for non-window scroll. Pass the same ref
  // you use for react-virtual's parentRef.
  rootRef?: React.RefObject<Element | null>,
): React.RefObject<E | null> {
  const targetRef = useRef<E | null>(null);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) onIntersect();
        }
      },
      { root: rootRef?.current ?? null, rootMargin: "200px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [onIntersect, rootRef]);
  return targetRef;
}
