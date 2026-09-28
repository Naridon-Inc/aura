// Live status for each agent PTY session, driven by OSC 777
// cli-agent notifications emitted by the agent's plugin scripts
// (aura-claude / aura-gemini / …).
//
// Why a separate store from `agentSessionStore`:
//   - agentSessionStore tracks block envelopes (Prompt/Output/Exit)
//     used by the AgentBlocksView.
//   - This store tracks discrete event deltas (PromptSubmit, Stop,
//     PermissionRequest, ToolComplete, IdlePrompt) that the AgentChip
//     and Manager DAG use to surface "is the agent waiting on me?".
//
// The two channels are complementary: blocks render *what was said*,
// events render *what state the agent is in*.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./api";
import type {
  CliAgentEvent,
  CliAgentEventEnvelope,
  CliAgentStatus,
} from "./api";
import {
  initialTurn,
  reduceTurn,
  settleTurn,
  turnWentQuiet,
  type TurnState,
} from "./agentTurnState";

/** How often a turn that reads `in_progress` checks whether its terminal has
 *  gone quiet. Only runs while a turn is open and something is subscribed. */
const QUIET_CHECK_MS = 2000;

type Entry = {
  sessionId: string;
  /** Status, when the turn opened, and when the last hook landed — see
   *  `agentTurnState` for the rules. `status` is read from here. */
  turn: TurnState;
  /** Last raw event we saw — kept so the chip popover can render
   *  details (tool name, query preview, plugin version) without us
   *  baking every field into `status`. */
  last: CliAgentEvent | null;
  /** Latest native window title (OSC 0/2) the agent set as it works —
   *  the same signal Warp reads to auto-title a row. `null` until the
   *  agent emits one. Preferred over the hook-derived activity label
   *  when present, since it's the agent's own words. */
  title: string | null;
  subs: Set<() => void>;
  unlisten: UnlistenFn | null;
  /** Companion unlisten for the `agent-title:<sid>` channel. */
  unlistenTitle: UnlistenFn | null;
  /** Set synchronously while an `attach()` is mid-`await`, before
   *  `unlisten` is assigned. Without it two concurrent attaches (rapid
   *  remount, two subscribers in one tick) both pass the `unlisten`
   *  null-check and double-subscribe, leaking the first listener. */
  pendingAttach: boolean;
  /** Interval that watches an open turn for the silence of an interrupt the
   *  CLI never reported. Null whenever the agent is not mid-turn. */
  quietWatch: ReturnType<typeof setInterval> | null;
};

type AgentTitleEvent = { session_id: string; title: string };

const entries = new Map<string, Entry>();

function ensureEntry(sessionId: string): Entry {
  let e = entries.get(sessionId);
  if (e) return e;
  e = {
    sessionId,
    turn: initialTurn(),
    last: null,
    title: null,
    subs: new Set(),
    unlisten: null,
    unlistenTitle: null,
    pendingAttach: false,
    quietWatch: null,
  };
  entries.set(sessionId, e);
  return e;
}

// Fleet-wide subscribers (the HUD publisher) — notified on ANY entry change so
// it can rebuild its roster + counts event-driven, not on a timer (timers throttle
// when the main window is hidden behind a fullscreen app — exactly movie mode).
const globalSubs = new Set<() => void>();

function emit(entry: Entry) {
  entry.subs.forEach((fn) => fn());
  globalSubs.forEach((fn) => fn());
}

function reduce(entry: Entry, ev: CliAgentEvent) {
  entry.last = ev;
  entry.turn = reduceTurn(entry.turn, ev, Date.now());
  watchQuiet(entry);
  emit(entry);
}

/** Keep the silence watch running exactly while a subscribed turn is open.
 *  Claude runs no Stop hook when it is interrupted, so without this the tab
 *  mark and the Chat view both kept saying "working" over an agent that had
 *  stopped, until the next prompt happened to close the turn. */
function watchQuiet(entry: Entry) {
  const want = entry.turn.status.kind === "in_progress" && entry.subs.size > 0;
  if (!want) {
    if (entry.quietWatch) {
      clearInterval(entry.quietWatch);
      entry.quietWatch = null;
    }
    return;
  }
  if (entry.quietWatch) return;
  entry.quietWatch = setInterval(() => {
    const opened = entry.turn;
    api
      .agentPtyIdleStatus(entry.sessionId)
      .then((pty) => {
        // A hook that landed while the check was in flight is newer news
        // than the silence it measured.
        if (entry.turn !== opened) return;
        if (turnWentQuiet(opened, pty, Date.now())) settle(entry);
      })
      .catch(() => {});
  }, QUIET_CHECK_MS);
}

function settle(entry: Entry) {
  const next = settleTurn(entry.turn);
  if (next === entry.turn) return;
  entry.turn = next;
  watchQuiet(entry);
  emit(entry);
}

/** Close a session's open turn now. The Chat view's Stop calls this once the
 *  terminal has gone quiet after its Escape — the CLI will not say so itself,
 *  and the button should not wait out the background watch to let go. */
export function settleAgentTurn(sessionId: string) {
  const e = entries.get(sessionId);
  if (e) settle(e);
}

function setTitle(entry: Entry, title: string | null) {
  const next = title && title.trim().length > 0 ? title : null;
  if (entry.title === next) return;
  entry.title = next;
  emit(entry);
}

async function attach(sessionId: string, entry: Entry) {
  // Bail if already attached OR an attach is in flight — the guard must
  // be synchronous, because `unlisten` isn't assigned until after the
  // awaits below and a second concurrent caller would otherwise also
  // subscribe.
  if (entry.unlisten || entry.pendingAttach) return;
  entry.pendingAttach = true;
  try {
    entry.unlisten = await listen<CliAgentEventEnvelope>(
      `agent-event:${sessionId}`,
      (e) => reduce(entry, e.payload.event),
    );
    // Native OSC 0/2 title stream — Warp-style "what I'm doing" string.
    entry.unlistenTitle = await listen<AgentTitleEvent>(
      `agent-title:${sessionId}`,
      (e) => setTitle(entry, e.payload.title),
    );
    // Backfill the current title in case the agent set it before we
    // subscribed (e.g. a session already running at app launch). Only
    // fills the initial gap — a live event that landed first wins.
    api
      .agentPtyTitle(sessionId)
      .then((t) => {
        if (entry.title === null) setTitle(entry, t);
      })
      .catch(() => {});
  } finally {
    entry.pendingAttach = false;
  }
  // Everyone unsubscribed while we were awaiting the listeners: detach()
  // ran with `unlisten` still null and couldn't tear them down, so do it
  // now that the handles exist — otherwise they'd dangle until the next
  // mount/unmount cycle (or forever, if there isn't one).
  if (entry.subs.size === 0) detach(entry);
}

function detach(entry: Entry) {
  if (entry.subs.size === 0) {
    watchQuiet(entry);
    if (entry.unlisten) {
      entry.unlisten();
      entry.unlisten = null;
    }
    if (entry.unlistenTitle) {
      entry.unlistenTitle();
      entry.unlistenTitle = null;
    }
  }
}

export function useAgentEvent(sessionId: string | null): {
  status: CliAgentStatus;
  last: CliAgentEvent | null;
  /** Native window title the agent set (OSC 0/2), or null. */
  title: string | null;
  /** Epoch ms the agent's current turn opened, or null between turns. */
  startedAt: number | null;
} {
  const [, force] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const entry = ensureEntry(sessionId);
    const fn = () => force((n) => n + 1);
    entry.subs.add(fn);
    watchQuiet(entry);
    attach(sessionId, entry).catch(() => {});
    return () => {
      entry.subs.delete(fn);
      detach(entry);
    };
  }, [sessionId]);

  if (!sessionId)
    return { status: { kind: "idle" }, last: null, title: null, startedAt: null };
  const entry = entries.get(sessionId);
  return {
    status: entry?.turn.status ?? { kind: "idle" },
    last: entry?.last ?? null,
    title: entry?.title ?? null,
    startedAt: entry?.turn.startedAt ?? null,
  };
}

/** Snapshot every known PTY/interactive agent's status without subscribing.
 *  The HUD publisher reads this on a tick to build the fleet roster +
 *  per-status counts — it can't call `useAgentEvent` once per agent. Keyed by
 *  session id. Only sessions some UI has subscribed to are present; absent =
 *  treat as idle. */
export function getAllAgentStatuses(): Map<string, CliAgentStatus> {
  const out = new Map<string, CliAgentStatus>();
  for (const [sid, e] of entries) out.set(sid, e.turn.status);
  return out;
}

/** Reactive whole-fleet status — re-renders the caller whenever ANY agent's
 *  status changes, without subscribing per session. Event-driven (no timer) so
 *  it keeps working when the main window is hidden behind a fullscreen app. */
export function useAllAgentStatuses(): Map<string, CliAgentStatus> {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    globalSubs.add(fn);
    return () => {
      globalSubs.delete(fn);
    };
  }, []);
  return getAllAgentStatuses();
}

/** Drop all cached state for a session. Call when closing the agent
 *  PTY so a future re-spawn under the same id starts clean. */
export function forgetAgentEvent(sessionId: string) {
  const e = entries.get(sessionId);
  if (e?.unlisten) e.unlisten();
  if (e?.unlistenTitle) e.unlistenTitle();
  if (e?.quietWatch) clearInterval(e.quietWatch);
  entries.delete(sessionId);
}
