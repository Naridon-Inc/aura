// Manager session store — pubsub mirror of backend ManagerSession JSON.
// Subscribes to `manager:<sid>` Tauri events; on each delta we replace
// the session in our Map and notify React subscribers. A 2s watchdog
// per session falls back to `manager_status` polling if no event is
// observed (covers the cold-start case where the Manager tab opens
// after the loop already emitted its initial PlanReady event).

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { placeForNewWork, readAmbientSid } from "./ambientSession";
import { api, type ManagerSession, type ManagerSummary } from "./api";
import { fetchManagerList } from "./managerCache";
import { forgetManagerSessionEverywhere } from "./editorStore";
import { notify as osNotify } from "./notifications";
import type { StreamBlock } from "../components/manager/chat/types";

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

// Why the snapshot fetch is failing, per session, and how many times running.
//
// Both load paths below used to `catch {}` on the grounds that the session
// "may not exist yet" and the event listener would fill it in. For a session
// that is genuinely mid-creation that's right. For one that will NEVER load —
// a deleted file, a session written by a newer build, a backend that errors on
// every read — it means the surface holds `null` forever and renders the
// loading placeholder for as long as the tab is open. We watched a real chat
// sit on "Loading conversation… · 420s" with no way to learn what went wrong.
//
// So the failure is kept. A COUNT, not a flag, because the optimistic reading
// has to survive: one miss right after `manager_chat_start` is ordinary, three
// in a row is a session that isn't coming.
const loadErrors = new Map<string, ManagerLoadError>();
const errorListeners = new Map<string, Set<(e: ManagerLoadError) => void>>();

// Consecutive misses after which the 2s watchdog stops asking. Past this the
// answer is not going to change on its own — the file is gone, or the backend
// can't read it — and every further tick is an IPC round-trip per dead tab
// that buys nothing. It also keeps the count the surface prints still: left
// running, "Aura asked 116 times" climbs forever and reads as noise rather
// than as evidence. `retryManagerSession` clears the record, so the user's
// "Try again" resumes the watchdog as well as re-fetching once.
const GIVE_UP_AFTER = 5;

// Consecutive misses that specifically say "no such file" after which the
// conversation is treated as gone rather than slow. Lower than GIVE_UP_AFTER
// because there is nothing to wait for: the file is either there or it isn't.
const GONE_AFTER = 3;

/** A snapshot fetch that keeps failing. `failures` counts consecutive misses. */
export interface ManagerLoadError {
  message: string;
  failures: number;
  /** The file this conversation was saved to is not on disk. Not "slow", not
   *  "flaky" — asking again cannot change the answer. */
  gone: boolean;
}

/** Does this failure mean the session file is missing, as opposed to the read
 *  going wrong some other way?
 *
 *  Worth separating because the two need opposite treatment. A read that fails
 *  for any other reason (busy disk, a partial write, a backend still starting)
 *  deserves the retries. A file that isn't there deserves none of them: five
 *  round-trips later the app still says "asked 5 times and got nothing back",
 *  which describes the *asking* rather than the answer, and the conversation
 *  is restored and asks again on the next launch. */
function isMissingFile(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no such file or directory") ||
    m.includes("os error 2") ||
    m.includes("notfound") ||
    m.includes("not found")
  );
}

function notifyError(sid: string) {
  const e = loadErrors.get(sid) ?? null;
  const set = errorListeners.get(sid);
  if (!set) return;
  for (const fn of set) fn(e ?? { message: "", failures: 0, gone: false });
}

function recordLoadFailure(sid: string, err: unknown) {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  const failures = (loadErrors.get(sid)?.failures ?? 0) + 1;
  // Missing-and-repeated, not missing-once: `manager_chat_start` hands back an
  // id before the first write lands, so one ENOENT on a session created a
  // moment ago is ordinary. Three misses is ~6s of the 2s watchdog, which is
  // past that window — the same threshold the surface uses to stop calling a
  // load "slow".
  const gone = isMissingFile(message) && failures >= GONE_AFTER;
  loadErrors.set(sid, { message, failures, gone });
  // Once, on the first miss — a retry every 2s must not flood the console.
  if (failures === 1) console.warn(`[manager ${sid}] snapshot failed: ${message}`);
  if (gone && failures === GONE_AFTER) {
    // Stop the tab coming back. The file is gone, so every future launch would
    // restore it, fail, and show the same screen — which is what "why does this
    // keep happening" looks like from the outside. The tab stays mounted and
    // says what happened; it just isn't remembered any more.
    const slots = forgetManagerSessionEverywhere(sid);
    if (slots > 0) {
      console.warn(
        `[manager ${sid}] session file is gone — dropped from ${slots} saved layout${slots === 1 ? "" : "s"}`,
      );
    }
  }
  notifyError(sid);
}

function clearLoadFailure(sid: string) {
  if (!loadErrors.delete(sid)) return;
  notifyError(sid);
}

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
      clearLoadFailure(sid);
      notify(sid);
    } catch (e) {
      // The session may genuinely not exist yet — `manager_chat_start` returns
      // its id before the first write lands — so this is not fatal on its own
      // and the watchdog below keeps trying. It IS recorded, because a miss
      // that repeats is a session that will never open and the surface has to
      // be able to say so.
      recordLoadFailure(sid, e);
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
    // Asked enough times. The surface is showing the reason and a Try again.
    const failed = loadErrors.get(sid);
    if ((failed?.failures ?? 0) >= GIVE_UP_AFTER) return;
    // A file that isn't there will not be there in two seconds either.
    if (failed?.gone) return;
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
      clearLoadFailure(sid);
      notify(sid);
    } catch (e) {
      recordLoadFailure(sid, e);
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

/** Why `sid`'s snapshot isn't arriving, once it has missed at least once.
 *  `null` while the fetch is merely outstanding — a surface that renders this
 *  as an error on the first tick would flash a failure at every new chat. */
export function useManagerLoadError(sid: string | null): ManagerLoadError | null {
  const [err, setErr] = useState<ManagerLoadError | null>(
    sid ? loadErrors.get(sid) ?? null : null,
  );
  useEffect(() => {
    if (!sid) {
      setErr(null);
      return;
    }
    let active = true;
    const fn = (e: ManagerLoadError) => {
      if (active) setErr(e.failures > 0 ? e : null);
    };
    let set = errorListeners.get(sid);
    if (!set) {
      set = new Set();
      errorListeners.set(sid, set);
    }
    set.add(fn);
    setErr(loadErrors.get(sid) ?? null);
    return () => {
      active = false;
      set?.delete(fn);
      if (set && set.size === 0) errorListeners.delete(sid);
    };
  }, [sid]);
  return err;
}

/** Drop the recorded failure and fetch again now, rather than waiting out the
 *  next 2s watchdog tick. What the surface's "Try again" is wired to. */
export async function retryManagerSession(sid: string): Promise<void> {
  clearLoadFailure(sid);
  if (polling.has(sid)) return;
  polling.add(sid);
  try {
    const snap = await api.managerStatus(sid);
    sessions.set(sid, snap);
    lastSeen.set(sid, Date.now());
    notify(sid);
  } catch (e) {
    recordLoadFailure(sid, e);
  } finally {
    polling.delete(sid);
  }
}

async function refreshSummaries() {
  try {
    summaries = await fetchManagerList();
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
  liveBlocks.delete(sid);
  if (had) notifyInFlight();
}

export function isManagerTurnInFlight(sid: string): boolean {
  return inFlightTurns.has(sid);
}

/** Is `repoRoot`'s ambient Aura chat mid-turn? For surfaces that ASK the brain
 *  a question instead of opening a pane — the Trace rail's Goals and Safety
 *  check rows — where the only evidence anything happened lands in a chat the
 *  user may not be looking at. Without this a second click looked free and
 *  quietly bought a second agent turn; the brain answered "Already ran this
 *  in-session… Re-running" and then interrupted itself. Re-reads on every
 *  mark/clear, so it flips the instant a turn arms or finishes. */
export function useAmbientTurnBusy(repoRoot: string | null | undefined): boolean {
  const tick = useManagerTurnsTick();
  void tick; // re-render trigger; the read below is deliberately uncached
  if (!repoRoot) return false;
  // The row that asked is the row that spins, and it asked from wherever the
  // window is standing — a question fired at a machine's copy of this project
  // must not light the local chat's spinner instead.
  const sid = readAmbientSid(repoRoot, placeForNewWork(repoRoot));
  return sid ? isManagerTurnInFlight(sid) : false;
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

// Durable per-session mirror of the in-flight turn's STREAM BLOCKS — the
// assistant prose, reasoning, and tool cards a turn has painted so far.
//
// The two markers above made a workspace switch keep the *indicator* honest
// ("Working… 3m 12s"), but the turn's actual visible output still lived only
// in `ManagerChatView`'s component-local `streamBlocks` useState — and that
// view is genuinely unmounted on a switch (AuraRailPanel nulls its ambient sid
// the moment `repoRoot` changes, dropping to the "Loading Aura…" branch). So
// switching away mid-turn and back erased every streamed paragraph, every tool
// row, and the live "Running …" row, leaving a bare "Thinking…" under the
// user's own message — which reads as if the turn restarted from zero. It
// never did: `brain_chat_turn` runs as a detached Tokio task and the view's
// cleanup deliberately refuses to cancel it.
//
// Tauri does not replay events emitted before `listen()`, and the backend only
// persists a manager turn once it COMPLETES — so nothing downstream can
// reconstruct a partial turn. Mirroring the blocks here is what makes the
// switch-back lossless. Entries are dropped the moment a turn terminates
// (empty write, or `clearManagerTurnInFlight`), so this holds at most one
// in-flight turn per session.
const liveBlocks = new Map<string, StreamBlock[]>();

/** Blocks streamed so far for `sid`'s in-flight turn. Empty when idle — the
 *  settled transcript in `session.chat` owns everything that finished. */
export function getManagerLiveBlocks(sid: string): StreamBlock[] {
  return liveBlocks.get(sid) ?? [];
}

/** Mirror the in-flight blocks for `sid`. An empty list drops the entry so the
 *  map never retains a settled turn. */
export function setManagerLiveBlocks(sid: string, blocks: StreamBlock[]): void {
  if (blocks.length === 0) liveBlocks.delete(sid);
  else liveBlocks.set(sid, blocks);
}
