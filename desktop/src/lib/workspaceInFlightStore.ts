// Parity W8 — optimistic in-flight tracking for workspace launches.
//
// `workspace_launch` takes seconds (worktree checkout + N agent spawns); the
// rail should show a live "creating…" tile the moment the user commits, not
// after the manifest lands. This is a tiny module-level store — same pattern
// as other ambient stores here — that `workspaceCreateStore.launchWorkspace`
// drives through the lifecycle: creating → spawning → ready | error. Ready
// entries auto-dismiss after a short beat (the real workspace tile has taken
// over by then); errors stick until explicitly dismissed so failures are
// never silently swallowed.
//
// WorkspaceRail subscribes directly via `useInFlight()` — no App.tsx prop
// threading for what is purely rail-local presentation state.

import { useSyncExternalStore } from "react";

export type InFlightStatus = "creating" | "spawning" | "ready" | "error";

export type InFlightEntry = {
  /** Unique per launch — also the dismiss handle. */
  key: string;
  repoRoot: string;
  branch: string;
  /** The ref the new branch was cut from (e.g. `origin/main`, `HEAD`) — shown
   *  in the setup feed's "Branched … from …" line. */
  startPoint?: string;
  /** Agent ids requested, in launch order. */
  agents: string[];
  startedAt: number;
  status: InFlightStatus;
  /** Set on status "error". */
  error?: string;
  /** Set once the worktree exists (spawning onward) — the click-through target. */
  worktreePath?: string;
};

const READY_DISMISS_MS = 4000;

let entries: InFlightEntry[] = [];
const listeners = new Set<() => void>();
let nextKey = 1;
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const fn of listeners) fn();
}

function patch(key: string, changes: Partial<InFlightEntry>) {
  let touched = false;
  entries = entries.map((e) => {
    if (e.key !== key) return e;
    touched = true;
    return { ...e, ...changes };
  });
  if (touched) emit();
}

/** Register a launch the moment the request fires. Returns the entry key. */
export function beginInFlight(
  repoRoot: string,
  branch: string,
  agents: string[],
  startPoint?: string,
): string {
  const key = `launch-${nextKey++}`;
  entries = [
    ...entries,
    {
      key,
      repoRoot,
      branch,
      startPoint,
      agents,
      startedAt: Date.now(),
      status: "creating",
    },
  ];
  emit();
  return key;
}

/** Worktree exists; agent PTYs are spawning. */
export function markInFlightSpawning(key: string, worktreePath: string) {
  patch(key, { status: "spawning", worktreePath });
}

/** Launch finished. Auto-dismisses after a short beat. */
export function markInFlightReady(key: string, worktreePath: string) {
  patch(key, { status: "ready", worktreePath });
  const timer = setTimeout(() => {
    dismissTimers.delete(key);
    dismissInFlight(key);
  }, READY_DISMISS_MS);
  dismissTimers.set(key, timer);
}

/** Launch failed. Sticks until the user dismisses it. */
export function markInFlightError(key: string, error: string) {
  patch(key, { status: "error", error });
}

export function dismissInFlight(key: string) {
  const timer = dismissTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    dismissTimers.delete(key);
  }
  const before = entries.length;
  entries = entries.filter((e) => e.key !== key);
  if (entries.length !== before) emit();
}

export function listInFlight(): InFlightEntry[] {
  return entries;
}

export function subscribeInFlight(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook — `entries` is replaced immutably on every change, so the array
 *  reference itself is the stable snapshot useSyncExternalStore needs. */
export function useInFlight(): InFlightEntry[] {
  return useSyncExternalStore(subscribeInFlight, listInFlight, listInFlight);
}
