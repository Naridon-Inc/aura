// The folders of a project as far as anyone has opened them. A folder is read
// the first time it opens and again each time it reopens; everything open is
// read again when the disk or git says something moved.
//
// A checkout on this laptop has a watcher, so a new or removed name re-reads
// just the folder it is in. A checkout on a machine has none — nothing here
// can see its disk — so it is re-read on a beat while on screen. Either way
// the re-read is quiet: the spinner is for the first paint only.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DirEntry } from "../../../lib/api";
import { loadDirList, peekDirList, reloadDirList } from "../../../lib/dirListCache";
import { usePanelActive } from "../../../lib/panelActive";
import { needsPolling, pathScope } from "../../../lib/place/workApi";
import { parentOf } from "./fileNodes";

/** How often a tree on a machine is re-listed while on screen. Every open
 *  folder is one round trip, so this is slower than the Changes list. */
const REMOTE_RELIST_MS = 15_000;
/** Watcher events arrive in bursts (a checkout, a formatter); one re-read per
 *  folder per burst. */
const WATCH_SETTLE_MS = 250;

export type DirListings = {
  listings: ReadonlyMap<string, DirEntry[]>;
  expanded: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  setOpen: (dir: string, open: boolean) => void;
  collapseAll: () => void;
  /** Read one folder again — after something was made, renamed or removed in it. */
  relist: (dir: string) => Promise<void>;
  /** Read everything open again. `quiet` keeps the tree on screen meanwhile. */
  relistAll: (quiet?: boolean) => Promise<void>;
};

export function useDirListings(root: string): DirListings {
  const active = usePanelActive();
  const [listings, setListings] = useState<Map<string, DirEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Async reads finish after renders; these are what they compare against, and
  // `rootRef` makes a late answer about a project you have left land nowhere.
  const rootRef = useRef(root);
  const listingsRef = useRef(listings);
  const expandedRef = useRef(expanded);
  listingsRef.current = listings;
  expandedRef.current = expanded;

  const store = useCallback((forRoot: string, dir: string, entries: DirEntry[]) => {
    if (rootRef.current !== forRoot) return;
    setListings((prev) => new Map(prev).set(dir, entries));
  }, []);

  const relistAll = useCallback(async (quiet = false) => {
    const forRoot = rootRef.current;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    const open = [...expandedRef.current];
    try {
      // `reload`, not `load`: this runs because something changed, and a read
      // already in flight started before it did.
      const top = await reloadDirList(forRoot);
      const read = await Promise.all(
        open.map((dir) =>
          reloadDirList(dir).then(
            (entries) => [dir, entries] as const,
            () => [dir, null] as const,
          ),
        ),
      );
      if (rootRef.current !== forRoot) return;
      const next = new Map<string, DirEntry[]>([[forRoot, top]]);
      const gone: string[] = [];
      for (const [dir, entries] of read) {
        if (entries) next.set(dir, entries);
        else gone.push(dir);
      }
      setListings(next);
      if (gone.length > 0)
        setExpanded((prev) => {
          const kept = new Set(prev);
          for (const dir of gone) kept.delete(dir);
          return kept;
        });
      setError(null);
    } catch (e) {
      // A quiet re-read that fails leaves the last good tree on screen.
      if (rootRef.current === forRoot && !quiet) setError(String(e));
    } finally {
      if (rootRef.current === forRoot && !quiet) setLoading(false);
    }
  }, []);

  const relist = useCallback(
    async (dir: string) => {
      const forRoot = rootRef.current;
      try {
        store(forRoot, dir, await reloadDirList(dir));
      } catch {
        /* the last listing stays; the next re-read tries again */
      }
    },
    [store],
  );

  const setOpen = useCallback(
    (dir: string, open: boolean) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.add(dir);
        else next.delete(dir);
        return next;
      });
      if (!open) return;
      // Painted from what was read last time, then read again.
      const forRoot = rootRef.current;
      loadDirList(dir).then(
        (entries) => store(forRoot, dir, entries),
        () => {
          if (!listingsRef.current.has(dir)) store(forRoot, dir, []);
        },
      );
    },
    [store],
  );

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // A new project: start from nothing, painted at once from the cache when it
  // has this folder, and read it fresh.
  // Which place the root is read at. The same root string names the laptop's
  // checkout and, once a machine is open over it, the machine's — so the tree
  // has to start again when this changes, or it goes on showing the laptop's
  // files inside the machine's workspace until the next poll.
  const scope = pathScope(root);
  useEffect(() => {
    rootRef.current = root;
    const cached = peekDirList(root);
    const start = new Map<string, DirEntry[]>(cached ? [[root, cached]] : []);
    listingsRef.current = start;
    expandedRef.current = new Set();
    setListings(start);
    setExpanded(new Set());
    setLoading(!cached);
    void relistAll(Boolean(cached));
  }, [root, scope, relistAll]);

  // Parked behind another tab nothing re-reads; coming back catches up.
  const parked = useRef(false);
  useEffect(() => {
    if (!active) {
      parked.current = true;
      return;
    }
    if (parked.current) {
      parked.current = false;
      void relistAll(true);
    }
  }, [active, relistAll]);

  // A commit, a branch switch, a job that touched files.
  useEffect(() => {
    if (!active) return;
    const onGitChanged = () => void relistAll(true);
    window.addEventListener("aura:git-changed", onGitChanged);
    return () => window.removeEventListener("aura:git-changed", onGitChanged);
  }, [active, relistAll]);

  // On a machine: re-read on a beat.
  useEffect(() => {
    if (!active || !needsPolling(root)) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void relistAll(true);
    }, REMOTE_RELIST_MS);
    return () => window.clearInterval(id);
  }, [root, scope, active, relistAll]);

  // On this laptop: the watcher says which name appeared or went away.
  useEffect(() => {
    if (!active || needsPolling(root)) return;
    let alive = true;
    let off: (() => void) | null = null;
    let timer: number | undefined;
    const pending = new Set<string>();
    const flush = () => {
      timer = undefined;
      for (const dir of pending) void relist(dir);
      pending.clear();
    };
    const base = root.replace(/\/+$/, "");
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ path: string; kind: string }>("fs:changed", (event) => {
          const { path, kind } = event.payload ?? {};
          if (!path || !path.startsWith(base + "/") || kind === "other") return;
          const dir = parentOf(path) ?? base;
          const known = listingsRef.current.get(dir === base ? root : dir);
          if (!known) return;
          // A save to a name the folder already has changes nothing here.
          if (kind === "modify" && known.some((entry) => entry.path === path)) return;
          pending.add(dir === base ? root : dir);
          if (timer === undefined) timer = window.setTimeout(flush, WATCH_SETTLE_MS);
        }),
      )
      .then((unlisten) => {
        if (alive) off = unlisten;
        else unlisten();
      })
      .catch(() => {
        /* no watcher here — the git and focus re-reads still run */
      });
    return () => {
      alive = false;
      off?.();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [root, scope, active, relist]);

  return { listings, expanded, loading, error, setOpen, collapseAll, relist, relistAll };
}
