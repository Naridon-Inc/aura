// Merged source-control snapshot: porcelain status + per-file numstat
// in one shape. The right-rail Changes panel reads this to render the
// staged / unstaged / untracked sections.
//
// ONE poll per repo, shared by every caller. Two panels used to mount this
// hook independently and each run its own 4s `git status` + numstat against
// the same repo — double the git for one identical answer. The store below
// keeps a single timer and a single cached snapshot per repo root; a second
// consumer paints instantly off the cache and adds no work.
//
// The other half of the cost was publishing regardless: fresh arrays every
// tick meant consumers' `useMemo`s re-derived, and downstream of that the
// Story panel re-fired a 12-way per-file `git diff` fan-out — every 4s, for a
// tree nobody had touched. So the store compares before it publishes and
// hands back the PREVIOUS array/Map identity when nothing moved.
//
// Polling pauses when the document is hidden and when the hosting panel is
// parked off-screen, and a failed read keeps the last good tree rather than
// blanking the panel.
//
// A project the window is standing in on a machine reads through the same
// store, keyed by the place as well as the root (`placeScope`), so a tree
// read off the box is never painted for the laptop's copy. There is no file
// watcher on that side — nothing here can see its disk — so the poll IS the
// refresh there, on a slightly slower beat because each read is a round trip
// over the wire rather than a process spawn (AURA-1306).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileDiffStat, GitStatusEntry } from "./api";
import { usePanelActive } from "./panelActive";
import {
  gitDiffStatsPerFile,
  gitStatusV2,
  needsPolling,
  placeScope,
  rootOfScope,
} from "./place/workApi";

export type ChangedFile = {
  path: string;
  /** "M" | "A" | "D" | "R" | "?" — derived from porcelain index/worktree. */
  status: string;
  index: string;
  worktree: string;
  additions: number;
  deletions: number;
};

export type GitChanges = {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  /** Total tracked-changed file count. Drives the section header chip. */
  changedCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const POLL_MS = 4000;
/** The beat for a checkout on a machine, where every read crosses the wire. */
const REMOTE_POLL_MS = 5000;

function deriveStatus(e: GitStatusEntry): string {
  if (e.index === "?" || e.worktree === "?") return "?";
  if (e.index === "A" || e.worktree === "A") return "A";
  if (e.index === "D" || e.worktree === "D") return "D";
  if (e.index === "R" || e.worktree === "R") return "R";
  return "M";
}

// ─── Shared per-repo store ───────────────────────────────────────────────

type Snapshot = {
  entries: GitStatusEntry[];
  stats: Map<string, FileDiffStat>;
  loading: boolean;
  error: string | null;
};

type Store = {
  snap: Snapshot;
  subs: Set<(s: Snapshot) => void>;
  timer: number | null;
  inFlight: boolean;
  /** A read was asked for while one was already running — run it again once
   *  this one settles rather than dropping it. */
  again: boolean;
};

const EMPTY: Snapshot = {
  entries: [],
  stats: new Map(),
  loading: false,
  error: null,
};

// Keyed by `placeScope(repoRoot)` — see the note at the top.
const stores = new Map<string, Store>();

function storeFor(scope: string): Store {
  let s = stores.get(scope);
  if (!s) {
    // `loading` starts true only for a repo we've never read — a remount
    // over a warm cache paints the last-known tree instead of a spinner.
    s = {
      snap: { ...EMPTY, stats: new Map(), loading: true },
      subs: new Set(),
      timer: null,
      inFlight: false,
      again: false,
    };
    stores.set(scope, s);
  }
  return s;
}

// Cheap identity checks — porcelain rows are already in a stable order, and
// a path's staged/unstaged letters plus its ±line counts are the whole of
// what any consumer renders. No stringifying a thousand-file tree.
function sameEntries(a: GitStatusEntry[], b: GitStatusEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].index !== b[i].index ||
      a[i].worktree !== b[i].worktree
    ) {
      return false;
    }
  }
  return true;
}

function sameStats(
  a: Map<string, FileDiffStat>,
  b: Map<string, FileDiffStat>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [path, s] of a) {
    const t = b.get(path);
    if (!t || t.additions !== s.additions || t.deletions !== s.deletions) {
      return false;
    }
  }
  return true;
}

function commit(s: Store, next: Snapshot): void {
  if (
    next.entries === s.snap.entries &&
    next.stats === s.snap.stats &&
    next.loading === s.snap.loading &&
    next.error === s.snap.error
  ) {
    return;
  }
  s.snap = next;
  for (const fn of s.subs) fn(next);
}

async function read(scope: string): Promise<void> {
  const s = stores.get(scope);
  if (!s) return;
  if (s.inFlight) {
    // Coalesce, don't drop. A stage/unstage refresh landing on top of a tick
    // has to be honoured — dropping it would leave the list stale for a full
    // poll after the user's own click.
    s.again = true;
    return;
  }
  s.inFlight = true;
  const repoRoot = rootOfScope(scope);
  try {
    const [es, st] = await Promise.all([
      gitStatusV2(repoRoot),
      gitDiffStatsPerFile(repoRoot).catch(() => [] as FileDiffStat[]),
    ]);
    const map = new Map<string, FileDiffStat>();
    for (const x of st) map.set(x.path, x);
    // Reuse the previous identity when nothing moved — this is what stops
    // the buckets memo (and the Story panel's diff fan-out downstream of it)
    // from recomputing on every tick of an idle tree.
    commit(s, {
      entries: sameEntries(s.snap.entries, es) ? s.snap.entries : es,
      stats: sameStats(s.snap.stats, map) ? s.snap.stats : map,
      loading: false,
      error: null,
    });
  } catch (e) {
    // Hold the last good tree. A `git status` that trips over an index.lock
    // mid-commit must not empty the panel under the user.
    commit(s, { ...s.snap, loading: false, error: String(e) });
  } finally {
    s.inFlight = false;
    if (s.again) {
      s.again = false;
      void read(scope);
    }
  }
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function retime(scope: string): void {
  const s = stores.get(scope);
  if (!s) return;
  const wanted = s.subs.size > 0 && documentVisible();
  if (wanted && s.timer === null) {
    const every = needsPolling(rootOfScope(scope)) ? REMOTE_POLL_MS : POLL_MS;
    s.timer = window.setInterval(() => void read(scope), every);
  } else if (!wanted && s.timer !== null) {
    window.clearInterval(s.timer);
    s.timer = null;
  }
}

let wired = false;

function wireGlobals(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => {
    for (const [scope, s] of stores) {
      retime(scope);
      if (documentVisible() && s.subs.size > 0) void read(scope);
    }
  });
  // Commit / push / pull / checkout anywhere in the app broadcasts this —
  // re-read at once so the list doesn't lag a tick behind the user's own move.
  window.addEventListener("aura:git-changed", () => {
    for (const [scope, s] of stores) {
      if (s.subs.size > 0) void read(scope);
    }
  });
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useGitChanges(repoRoot: string | null | undefined): GitChanges {
  const panelActive = usePanelActive();
  // Where the project is read from is part of what is being watched: the
  // same root on this laptop and on a machine are two different trees.
  const scope = repoRoot ? placeScope(repoRoot) : null;
  const [snap, setSnap] = useState<Snapshot>(() =>
    scope ? storeFor(scope).snap : EMPTY,
  );

  useEffect(() => {
    if (!scope) {
      setSnap(EMPTY);
      return;
    }
    // Parked behind another tab: drop the subscription, which also retires
    // the shared timer once the last live watcher is gone. The snapshot we
    // already hold stays on screen for the re-entry paint.
    if (!panelActive) return;
    wireGlobals();
    const s = storeFor(scope);
    setSnap(s.snap);
    s.subs.add(setSnap);
    retime(scope);
    void read(scope);
    return () => {
      s.subs.delete(setSnap);
      retime(scope);
    };
  }, [scope, panelActive]);

  const refresh = useCallback(() => {
    if (scope) void read(scope);
  }, [scope]);

  // Build ChangedFile rows. A single porcelain entry can be both staged
  // AND have unstaged changes (`MM`) — surface it in BOTH sections so
  // the user can stage/unstage each side independently. Untracked is
  // its own bucket (`??`).
  //
  // Memoize on entries+stats refs (state) so consumer-side useMemos
  // that take staged/unstaged/untracked as deps don't see fresh array
  // references on every render — that caused infinite render loops in
  // EditViewPanel, where an effect downstream of `changedFiles` set
  // state every commit. The store above keeps those refs stable across
  // an unchanged poll, so this memo now also survives the 4s tick.
  const buckets = useMemo(() => {
    const all: ChangedFile[] = snap.entries.map((e) => {
      const s = snap.stats.get(e.path);
      return {
        path: e.path,
        status: deriveStatus(e),
        index: e.index,
        worktree: e.worktree,
        additions: s?.additions ?? 0,
        deletions: s?.deletions ?? 0,
      };
    });
    const staged = all.filter((f) => f.index && f.index !== "?");
    const unstaged = all.filter(
      (f) => f.worktree && f.worktree !== "?" && f.index !== "?",
    );
    const untracked = all.filter((f) => f.index === "?" || f.worktree === "?");
    const trackedPaths = new Set<string>();
    for (const f of staged) trackedPaths.add(f.path);
    for (const f of unstaged) trackedPaths.add(f.path);
    return {
      staged,
      unstaged,
      untracked,
      changedCount: trackedPaths.size,
    };
  }, [snap.entries, snap.stats]);

  return {
    staged: buckets.staged,
    unstaged: buckets.unstaged,
    untracked: buckets.untracked,
    changedCount: buckets.changedCount,
    loading: snap.loading,
    error: snap.error,
    refresh,
  };
}
