// Lanes (AURA-81) — module-level store for the active lane roster plus
// the spawn / refresh / discard actions the LaneSwitcher drives.
//
// A "lane" is Aura's built-in answer to running two coding agents in
// parallel without hand-rolling a worktree or switching branches: each
// lane is an isolated managed worktree on an auto-named `lane/*` branch
// with its own agent PTY (own working tree, index, HEAD, cwd). The
// backend (cmd_lane.rs) owns all the git/worktree mechanics; this store
// is a thin, subscribable mirror of the lane list keyed by workspace
// root, following editorStore's module-state + subscriber-set pattern.
//
// State is per-workspace (`lanesByRoot`) so switching workspaces shows
// that workspace's own lanes. `activeLaneByRoot` tracks which lane the
// user is focused on so the switcher can highlight it; it's advisory
// (the lane list is the source of truth) and clears when its lane is
// discarded.

import { useEffect, useState } from "react";
import { api, type Lane, type LaneDiscardResult } from "./api";

type State = {
  /** Active lanes per workspace root. */
  lanesByRoot: Map<string, Lane[]>;
  /** Focused lane id (branch) per workspace root, advisory. */
  activeLaneByRoot: Map<string, string | null>;
  /** Roots with an in-flight spawn — drives the switcher's "starting…"
   *  affordance so a double-click can't fire two spawns. */
  spawningRoots: Set<string>;
};

let state: State = {
  lanesByRoot: new Map(),
  activeLaneByRoot: new Map(),
  spawningRoots: new Set(),
};

const subs = new Set<() => void>();

function emit() {
  subs.forEach((fn) => fn());
}

/** Replace state with a shallow-cloned copy so React's identity checks
 *  see a change. The Maps/Set are cloned, not mutated in place. */
function setState(mut: (draft: State) => void) {
  const next: State = {
    lanesByRoot: new Map(state.lanesByRoot),
    activeLaneByRoot: new Map(state.activeLaneByRoot),
    spawningRoots: new Set(state.spawningRoots),
  };
  mut(next);
  state = next;
  emit();
}

// ── Reads ────────────────────────────────────────────────────────────

/** The lanes currently known for `repoRoot` (empty until refreshed). */
export function getLanes(repoRoot: string): Lane[] {
  return state.lanesByRoot.get(repoRoot) ?? [];
}

/** The focused lane id for `repoRoot`, or null. */
export function getActiveLaneId(repoRoot: string): string | null {
  return state.activeLaneByRoot.get(repoRoot) ?? null;
}

/** Is a spawn in flight for `repoRoot`? */
export function isSpawning(repoRoot: string): boolean {
  return state.spawningRoots.has(repoRoot);
}

// ── Actions ──────────────────────────────────────────────────────────

/** Pull the live lane roster for `repoRoot` from the backend. Reconciles
 *  the focused-lane pointer (drops it if its lane has gone away). */
export async function refreshLanes(repoRoot: string): Promise<Lane[]> {
  const lanes = await api.laneList(repoRoot);
  setState((d) => {
    d.lanesByRoot.set(repoRoot, lanes);
    const active = d.activeLaneByRoot.get(repoRoot) ?? null;
    if (active && !lanes.some((l) => l.id === active)) {
      d.activeLaneByRoot.set(repoRoot, lanes[0]?.id ?? null);
    }
  });
  return lanes;
}

/** Spawn a fresh lane for `agent` in `repoRoot`. Optimistically marks the
 *  root as spawning, appends the returned lane, and focuses it. Always
 *  clears the spawning flag (even on failure) so the UI doesn't wedge. */
export async function spawnLane(
  repoRoot: string,
  agent: string,
  label?: string,
): Promise<Lane> {
  setState((d) => {
    d.spawningRoots.add(repoRoot);
  });
  try {
    const lane = await api.laneSpawn(repoRoot, agent, label);
    setState((d) => {
      const list = d.lanesByRoot.get(repoRoot) ?? [];
      // De-dupe by id in case a concurrent refresh already added it.
      const next = list.some((l) => l.id === lane.id)
        ? list.map((l) => (l.id === lane.id ? lane : l))
        : [...list, lane];
      d.lanesByRoot.set(repoRoot, next);
      d.activeLaneByRoot.set(repoRoot, lane.id);
    });
    return lane;
  } finally {
    setState((d) => {
      d.spawningRoots.delete(repoRoot);
    });
  }
}

/** Discard a lane. On a clean (or forced) discard the lane is dropped
 *  from the roster locally; on the dirty-guard hit nothing is removed and
 *  the `dirty` result is returned so the caller can confirm + re-call
 *  with force=true. */
export async function discardLane(
  repoRoot: string,
  laneId: string,
  force = false,
): Promise<LaneDiscardResult> {
  const result = await api.laneDiscard(repoRoot, laneId, force);
  if (result.kind === "discarded") {
    setState((d) => {
      const list = (d.lanesByRoot.get(repoRoot) ?? []).filter((l) => l.id !== laneId);
      d.lanesByRoot.set(repoRoot, list);
      if (d.activeLaneByRoot.get(repoRoot) === laneId) {
        d.activeLaneByRoot.set(repoRoot, list[0]?.id ?? null);
      }
    });
  }
  return result;
}

/** Focus a lane (advisory — highlights it in the switcher). */
export function setActiveLane(repoRoot: string, laneId: string | null): void {
  setState((d) => {
    d.activeLaneByRoot.set(repoRoot, laneId);
  });
}

// ── Hook ─────────────────────────────────────────────────────────────

export type UseLanes = {
  lanes: Lane[];
  activeLaneId: string | null;
  spawning: boolean;
};

/** Subscribe a component to the lane roster for `repoRoot`. Auto-refreshes
 *  once on mount (and whenever the root changes) so the switcher is live
 *  the moment it opens. */
export function useLanes(repoRoot: string | null): UseLanes {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    if (repoRoot) {
      refreshLanes(repoRoot).catch(() => {
        /* a repo with no lanes / no git just yields [] — non-fatal */
      });
    }
    return () => {
      subs.delete(fn);
    };
  }, [repoRoot]);

  if (!repoRoot) {
    return { lanes: [], activeLaneId: null, spawning: false };
  }
  return {
    lanes: getLanes(repoRoot),
    activeLaneId: getActiveLaneId(repoRoot),
    spawning: isSpawning(repoRoot),
  };
}
