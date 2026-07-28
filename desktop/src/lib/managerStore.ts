// Manager session store — pubsub mirror of backend ManagerSession JSON.
// Subscribes to `manager:<sid>` Tauri events; on each delta we replace
// the session in our Map and notify React subscribers. A 2s watchdog
// per session falls back to `manager_status` polling if no event is
// observed (covers the cold-start case where the Manager tab opens
// after the loop already emitted its initial PlanReady event).

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type ManagerSession, type ManagerSummary } from "./api";
import { notify as osNotify } from "./notifications";

type Listener = (session: ManagerSession | null) => void;

const sessions = new Map<string, ManagerSession>();
const listeners = new Map<string, Set<Listener>>();
const unlistens = new Map<string, UnlistenFn>();
const watchdogs = new Map<string, ReturnType<typeof setInterval>>();
const lastSeen = new Map<string, number>();
// Sessions with a `managerStatus` fetch currently in flight. A large session
// file can take longer than the 2s watchdog tick to load + parse; without this
// guard each tick stacks another concurrent fetch, the slow loads pile up, and
// the surface never leaves its "Loading…" state. One poll at a time per sid.
const polling = new Set<string>();

let summaries: ManagerSummary[] = [];
const summaryListeners = new Set<() => void>();
let summaryUnlisten: UnlistenFn | null = null;

function notifySummary() {
  for (const fn of summaryListeners) fn();
}

function notify(sid: string) {
  const s = sessions.get(sid) ?? null;
  const set = listeners.get(sid);
  if (!set) return;
  for (const fn of set) fn(s);
}

async function attachSession(sid: string) {
  if (unlistens.has(sid)) return;
  const off = await listen<ManagerSession>(`manager:${sid}`, (e) => {
    sessions.set(sid, e.payload);
    lastSeen.set(sid, Date.now());
    notify(sid);
  });
  // A turn that couldn't be written to disk surfaces here so the user is
  // actually told. The backend keeps the turn in memory (so nothing is lost
  // while the app runs), but a person has a right to know "this didn't save"
  // rather than discover it missing on reload. We raise an OS notification —
  // which fires when the window is unfocused, exactly the walk-away case where
  // the turn could still be lost if the app closes — and log it for the case
  // where they're looking at the chat.
  const offErr = await listen<string>(`manager-persist-error:${sid}`, (e) => {
    const message = e.payload || "A message couldn't be saved to this device.";
    console.error(`[manager ${sid}] ${message}`);
    void osNotify({
      title: "Couldn't save your message",
      body: message,
      dedupeKey: `persist-error:${sid}`,
    });
  });
  unlistens.set(sid, () => {
    off();
    offErr();
  });

  // Initial snapshot — covers reattach when the tab opens after the
  // loop has already started, since Tauri events from before the
  // listen call aren't replayed. Guarded so a slow first load can't be
  // re-entered by the watchdog below while it's still resolving.
  if (!polling.has(sid)) {
    polling.add(sid);
    try {
      const snap = await api.managerStatus(sid);
      sessions.set(sid, snap);
      lastSeen.set(sid, Date.now());
      notify(sid);
    } catch {
      // Session may not exist yet; the listener will pick it up.
    } finally {
      polling.delete(sid);
    }
  }

  // Cold-start watchdog — if we haven't seen any event in 2s and the
  // session is still Running, re-poll. Catches missed deltas without
  // the cost of permanent polling.
  const wd = setInterval(async () => {
    const last = lastSeen.get(sid) ?? 0;
    if (Date.now() - last < 2000) return;
    const cached = sessions.get(sid);
    if (cached && (cached.status === "completed" || cached.status === "cancelled")) return;
    // A previous poll is still resolving (a large session can take longer than
    // the 2s tick to load + parse). Skip this tick rather than stacking another
    // concurrent fetch — overlapping slow loads are what pinned the surface on
    // "Loading…" forever.
    if (polling.has(sid)) return;
    polling.add(sid);
    try {
      const snap = await api.managerStatus(sid);
      // The watchdog only exists to FILL missed deltas, never to erase. A
      // snapshot with fewer chat turns than we already hold is stale (e.g. an
      // in-memory base lagging the live event stream) — keep the richer cached
      // session so the transcript can't blink out. Still refresh `lastSeen` so
      // we don't re-poll in a tight loop.
      const snapLen = snap.chat?.length ?? 0;
      const curLen = cached?.chat?.length ?? 0;
      if (cached && snapLen < curLen) {
        lastSeen.set(sid, Date.now());
        return;
      }
      sessions.set(sid, snap);
      lastSeen.set(sid, Date.now());
      notify(sid);
    } catch {
      // Ignore — session may have been removed.
    } finally {
      polling.delete(sid);
    }
  }, 2000);
  watchdogs.set(sid, wd);
}

function detachSession(sid: string) {
  const off = unlistens.get(sid);
  if (off) {
    off();
    unlistens.delete(sid);
  }
  const wd = watchdogs.get(sid);
  if (wd) {
    clearInterval(wd);
    watchdogs.delete(sid);
  }
}

export function useManagerSession(sid: string | null): ManagerSession | null {
  const [snap, setSnap] = useState<ManagerSession | null>(
    sid ? sessions.get(sid) ?? null : null,
  );
  useEffect(() => {
    if (!sid) {
      setSnap(null);
      return;
    }
    let active = true;
    const fn: Listener = (s) => {
      if (active) setSnap(s);
    };
    let set = listeners.get(sid);
    if (!set) {
      set = new Set();
      listeners.set(sid, set);
    }
    set.add(fn);
    setSnap(sessions.get(sid) ?? null);
    void attachSession(sid);
    return () => {
      active = false;
      set?.delete(fn);
      if (set && set.size === 0) {
        listeners.delete(sid);
        detachSession(sid);
      }
    };
  }, [sid]);
  return snap;
}

async function refreshSummaries() {
  try {
    summaries = await api.managerList();
    notifySummary();
  } catch {
    // Backend not ready / no sessions — ignore.
  }
}

export function useManagerSummaries(): ManagerSummary[] {
  const [list, setList] = useState<ManagerSummary[]>(summaries);
  useEffect(() => {
    const fn = () => setList([...summaries]);
    summaryListeners.add(fn);
    void refreshSummaries();
    if (!summaryUnlisten) {
      // Any manager:* event invalidates the summary list. There's no
      // wildcard listener in Tauri so we re-poll on a 5s interval —
      // cheap because manager_list is a directory scan + read.
      const id = setInterval(refreshSummaries, 5000);
      summaryUnlisten = () => clearInterval(id);
    }
    return () => {
      summaryListeners.delete(fn);
      if (summaryListeners.size === 0 && summaryUnlisten) {
        summaryUnlisten();
        summaryUnlisten = null;
      }
    };
  }, []);
  return list;
}

export function getManagerSession(sid: string): ManagerSession | null {
  return sessions.get(sid) ?? null;
}

// ── In-flight native-turn registry ─────────────────────────────────────
// A native brain chat turn (`brain_chat_turn`) runs as a spawned Tokio task
// server-side and keeps streaming whether or not any frontend listener is
// attached. The chat view, however, is unmounted+remounted on a workspace
// switch (AuraRailPanel re-resolves its ambient sid per repoRoot), so its
// component-local `busy` flag is lost across the switch.
//
// This module-level set is the *durable* "a turn I started hasn't finished
// yet" marker — it lives in the store singleton, so it survives the chat
// view's unmount and is still readable when the same session's surface
// remounts after the user switches back. On remount the chat seeds its
// working indicator from this set (so a still-running turn reads as
// "Working…", not a frozen pre-switch snapshot) and the live chunk channel
// re-subscribes to resume the stream. Cleared on any terminal chunk
// (end/error), on explicit Stop, and self-corrected on remount once the
// completed assistant turn lands in the persisted snapshot.
const inFlightTurns = new Set<string>();

// Durable per-session turn-start timestamp (epoch ms), paired with the
// in-flight marker above. The chat view's elapsed ("Working… 12s") timer
// used to live in a component-local ref that died on the workspace-switch
// unmount — so switching away from a still-running turn and back restarted
// the counter at 0, reading as if nothing had been happening. The backend
// run never stopped; only the *displayed* elapsed reset. Persisting the
// start here lets the remounted view resume the real elapsed time.
const turnStartedAt = new Map<string, number>();

// Observers of the in-flight set. A plain Set isn't observable, so a chat view
// that DIDN'T start a turn has no way to learn one just went in-flight for the
// session it's showing — the working indicator would stay dark while the turn
// streams. That's exactly the "a message injected from the HUD / sidebar shows
// no working state" bug: `sendAmbientManagerTurn` marks the registry but never
// touches the mounted view's component-local `busy`, and since the session id
// doesn't change nothing re-seeds it. These listeners let a mounted view adopt
// an externally-started turn: every mark/clear notifies, the view re-reads
// `isManagerTurnInFlight(sid)` and lights (or the terminal chunk clears) its
// indicator. Notification is fire-and-forget and swallows listener throws so
// one bad subscriber can't wedge the rest.
const inFlightListeners = new Set<() => void>();

function notifyInFlight(): void {
  for (const fn of inFlightListeners) {
    try {
      fn();
    } catch (e) {
      console.warn("[manager] in-flight listener threw", e);
    }
  }
}

/** Subscribe to in-flight-turn changes across ALL sessions. The listener fires
 *  after every mark/clear; read `isManagerTurnInFlight(sid)` inside for the
 *  session you care about. Returns an unsubscribe fn. */
export function subscribeManagerTurns(fn: () => void): () => void {
  inFlightListeners.add(fn);
  return () => {
    inFlightListeners.delete(fn);
  };
}

/** Re-render on every in-flight-turn change. `useWorkingRoots` /
 *  `useFleetActivity` read `isManagerTurnInFlight` inside a memo whose only
 *  reactive input was the 5s summary poll — so a turn that armed BETWEEN polls
 *  (a message injected from the floating HUD or a sidebar composer) didn't light
 *  the sidebar's working state for up to five seconds. That's the "aura chat is
 *  running but the sidebar isn't showing it" report. Subscribing here makes any
 *  hook that folds this tick into its deps recompute the instant a turn marks or
 *  clears. Returns a monotonically-bumping counter to use as a memo dependency. */
export function useManagerTurnsTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeManagerTurns(() => setTick((t) => t + 1)), []);
  return tick;
}

export function markManagerTurnInFlight(sid: string): void {
  const had = inFlightTurns.has(sid);
  inFlightTurns.add(sid);
  if (!had) notifyInFlight();
}

export function clearManagerTurnInFlight(sid: string): void {
  const had = inFlightTurns.has(sid);
  inFlightTurns.delete(sid);
  turnStartedAt.delete(sid);
  if (had) notifyInFlight();
}

export function isManagerTurnInFlight(sid: string): boolean {
  return inFlightTurns.has(sid);
}

/** Durable epoch-ms start of the in-flight turn for `sid`, if one is running.
 *  Survives the chat view's workspace-switch unmount so the elapsed timer
 *  resumes from the real start instead of restarting at 0. `null` when idle. */
export function getManagerTurnStartedAt(sid: string): number | null {
  return turnStartedAt.get(sid) ?? null;
}

/** Stamp the durable turn-start for `sid` if not already set, returning the
 *  effective start. Idempotent so a remount reuses the original stamp rather
 *  than overwriting it with "now". */
export function setManagerTurnStartedAt(sid: string, startedAt: number): number {
  const existing = turnStartedAt.get(sid);
  if (existing != null) return existing;
  turnStartedAt.set(sid, startedAt);
  return startedAt;
}

/** Drop the durable turn-start for `sid` (turn settled / spinner cleared). */
export function clearManagerTurnStartedAt(sid: string): void {
  turnStartedAt.delete(sid);
}
