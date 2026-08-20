// Subscriber-set store for clean-bubble agent stream sessions, keyed by
// the same "{agent_id}@{repo_root}" channel id the backend uses for its
// emit topic. Mirrors `agentSessionStore.ts` in shape but holds typed
// `StreamEvent`s instead of raw block envelopes — these come from
// `claude -p --output-format stream-json` and already carry the typed
// content blocks the bubble UI needs.
//
// Lifecycle:
//   1. First subscriber attaches a tauri listener on
//      `agent-stream:<channel>` and `agent-stream-done:<channel>`.
//   2. Every event is appended in-order. Adjacent assistant_text events
//      with the same turn_id stay separate; the renderer groups them.
//   3. The session_id surfaced on `system_init` is captured separately
//      so the next prompt can `--resume` the same conversation.
//   4. Reference-counted detach — cached events survive remounts.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  type ClaudeSession,
  type PermissionMode,
  type StreamEvent,
  type StreamExitInfo,
} from "./api";
import { notify } from "./notifications";
import { playCompletionChime } from "./completionChime";
import { basename } from "./paths";

// Tools that need a human in the loop — claude can't fulfill them on
// its own and stalls waiting for our answer. We fire OS notifications
// for these so an unfocused user sees the agent is parked.
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// Wave B knobs.
//   SNAPSHOT_TOOLS — tools whose tool_input has a `file_path` we should
//     pre-snapshot so `aura rewind` can recover the file later.
//   WATCHDOG_MS    — how long after a tool_use before we nag the user
//     for a missing intent log entry.
//   INTENT_GRACE_MS — accept intents logged slightly before the
//     tool_use too (clock skew + the agent racing the snapshot).
const SNAPSHOT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const WATCHDOG_MS = 30_000;
const INTENT_GRACE_MS = 5_000;

export type StreamSessionState = {
  events: StreamEvent[];
  /** Session id from the most recent `system_init`. Used to `--resume`
   *  follow-up turns into the same Claude conversation. */
  sessionId: string | null;
  /** True between agent_stream_send and the matching done event for the
   *  most recent turn. Drives the typing indicator + Stop button. */
  running: boolean;
  /** Full ClaudeSession metadata when the user explicitly resumed an
   *  on-disk conversation via the picker. Drives the session-info card
   *  at the top of the bubble view. Cleared on /clear or new session. */
  resumedSession: ClaudeSession | null;
};

type PendingTool = {
  name: string;
  filePath: string | null;
  startedAt: number;
  turnId: string;
  timeoutId: number;
};

type Entry = {
  state: StreamSessionState;
  subs: Set<() => void>;
  unlistenStream: UnlistenFn | null;
  unlistenDone: UnlistenFn | null;
  /** Monotonic generation counter — bumped on every (re)attach so a
   *  detach scheduled by a stale React effect cleanup can't tear down
   *  the live listener. The cleanup compares its captured gen with the
   *  current one and only unlistens if they match. */
  gen: number;
  /** Repo root + agent id pinned via bindChannelMeta on send dispatch.
   *  Channel string sanitizes path separators so we can't recover the
   *  real disk path from it; the dispatcher passes the original. */
  repoRoot: string | null;
  agentId: string | null;
  /** Wall-clock when the most recent turn started — drives the
   *  watchdog's intent-log scan window. */
  sessionStartedAt: number | null;
  /** Per-tool_use_id watchdogs. Keyed by `id` from the tool_use event so
   *  cancellation on user input is O(1). */
  pendingTools: Map<string, PendingTool>;
  /** Active claude `--permission-mode`. Persisted in localStorage per
   *  channel so toggling plan-mode on a tab is sticky across reloads. */
  permissionMode: PermissionMode;
};

const entries = new Map<string, Entry>();

export function streamChannel(agentId: string, repoRoot: string): string {
  // Must match cmd_agent_stream.rs::sanitize_channel — Tauri's event-
  // name validator rejects anything outside [A-Za-z0-9/_:-], so a raw
  // path like "/Users/muhammed/Documents/New Git/..." would silently
  // no-op every emit. Normalize to alphanumeric + `_` + `-` on both
  // sides so the Rust topic string and the JS listen() string agree.
  return `${agentId}@${repoRoot}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function ensureEntry(channel: string): Entry {
  let e = entries.get(channel);
  if (e) return e;
  e = {
    state: { events: [], sessionId: null, running: false, resumedSession: null },
    subs: new Set(),
    unlistenStream: null,
    unlistenDone: null,
    gen: 0,
    repoRoot: null,
    agentId: null,
    sessionStartedAt: null,
    pendingTools: new Map(),
    permissionMode: loadPermissionMode(channel),
  };
  entries.set(channel, e);
  return e;
}

function permissionModeKey(channel: string): string {
  return `aura.stream.permissionMode.${channel}`;
}

function loadPermissionMode(channel: string): PermissionMode {
  try {
    const v = localStorage.getItem(permissionModeKey(channel));
    if (v === "plan" || v === "acceptEdits" || v === "bypassPermissions") return v;
  } catch {
    // localStorage may be unavailable in non-browser test environments.
  }
  return "default";
}

export function getPermissionMode(channel: string): PermissionMode {
  return entries.get(channel)?.permissionMode ?? loadPermissionMode(channel);
}

export function setPermissionMode(channel: string, mode: PermissionMode) {
  const entry = ensureEntry(channel);
  if (entry.permissionMode === mode) return;
  entry.permissionMode = mode;
  try {
    if (mode === "default") localStorage.removeItem(permissionModeKey(channel));
    else localStorage.setItem(permissionModeKey(channel), mode);
  } catch {
    // ditto.
  }
  emit(entry);
}

/** Append a fully-formed StreamEvent into the entry. Used by the
 *  dispatch site (App.tsx → runAgentPrompt) to push the user's prompt
 *  bubble *before* awaiting the backend, so it shows up instantly even
 *  if the backend takes a tick to spin up — no race with listener
 *  attach. The backend does not emit UserPrompt for the same reason. */
export function pushEvent(channel: string, ev: StreamEvent) {
  const entry = ensureEntry(channel);
  applyEvent(entry, ev);
}

// Fleet-wide subscribers (the HUD publisher) — notified on ANY channel change so
// it can rebuild its roster + counts event-driven, not on a timer (timers throttle
// when the main window is hidden behind a fullscreen app — exactly movie mode).
const globalSubs = new Set<() => void>();

function emit(entry: Entry) {
  entry.subs.forEach((fn) => fn());
  globalSubs.forEach((fn) => fn());
}

// Hard cap on retained stream events per channel. A long Claude run
// can fire thousands of events (text deltas + tool_use + tool_result
// with file payloads). Without this cap a tab left open for an hour
// will hold the entire transcript in JS heap forever. We keep the
// first system_init (needed so the resume affordance still knows the
// session id) plus the most recent EVENT_RETENTION events.
const EVENT_RETENTION = 800;

function trimEvents(prev: StreamEvent[], next: StreamEvent): StreamEvent[] {
  if (prev.length < EVENT_RETENTION) return [...prev, next];
  // Keep the first system_init so resume affordance + session id stay
  // resolvable, then trim the older middle.
  const init = prev.find((e) => e.kind === "system_init") ?? null;
  const tail = prev.slice(prev.length - (EVENT_RETENTION - (init ? 1 : 0)));
  return init && tail[0] !== init ? [init, ...tail, next] : [...tail, next];
}

function applyEvent(entry: Entry, ev: StreamEvent) {
  const events = trimEvents(entry.state.events, ev);
  const wasRunning = entry.state.running;
  let sessionId = entry.state.sessionId;
  let running = entry.state.running;
  if (ev.kind === "system_init" && ev.session_id) {
    sessionId = ev.session_id;
    // Auto-pin every new session id on disk so a shell restart can
    // restore the conversation via --resume <sid>. Previously this
    // only fired when the user explicitly picked a past session via
    // ResumeDialog, which meant fresh chats were lost on reload.
    persistLastSessionId(entry, ev.session_id);
  }
  if (ev.kind === "result") {
    running = false;
  }
  entry.state = { ...entry.state, events, sessionId, running };

  // W7 ambient — turn-end. A streamed agent run just finished (running
  // true → false). Play the completion chime (always, the delight cue)
  // and fire an OS notification (only when unfocused). Cross-agent: this
  // seam covers every CLI agent driven through the stream store; the
  // native brain fires the same chime from ManagerChatView's done/end.
  if (ev.kind === "result" && wasRunning) {
    playCompletionChime();
    notify({
      title: `Aura · ${entry.agentId ?? "agent"} finished`,
      body: "The turn is done.",
      dedupeKey: `turn-end:${channelOf(entry)}`,
    }).catch(() => {});
  }

  // B1 + B2: aura side effects. Fire a snapshot on Edit/Write/MultiEdit
  // tool_use, and start an intent-log watchdog. New user_prompt clears
  // pending watchdogs (the user moved on; a stale nudge is noise).
  if (ev.kind === "tool_use") {
    handleToolUseSideEffects(entry, ev);
    if (INTERACTIVE_TOOLS.has(ev.name)) {
      const label =
        ev.name === "ExitPlanMode" ? "shared a plan" : "has a question";
      notify({
        title: `Aura · ${entry.agentId ?? "agent"} ${label}`,
        body: "Open the chat to respond.",
        dedupeKey: `interactive:${ev.id}`,
      }).catch(() => {});
    }
  } else if (ev.kind === "user_prompt") {
    cancelAllWatchdogs(entry);
  }

  emit(entry);
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const fp = obj.file_path ?? obj.filePath ?? obj.path;
  return typeof fp === "string" ? fp : null;
}

function handleToolUseSideEffects(
  entry: Entry,
  ev: Extract<StreamEvent, { kind: "tool_use" }>,
) {
  if (!SNAPSHOT_TOOLS.has(ev.name)) return;
  const filePath = extractFilePath(ev.input);
  if (!filePath || !entry.repoRoot) return;
  const repoRoot = entry.repoRoot;

  // B1 — fire-and-forget snapshot. We synthesize a local `aura_snapshot`
  // event so the UI can render it inline (or filter it out). Backend
  // failures are silent; History sidebar is the source of truth.
  api
    .auraSnapshot(repoRoot, filePath)
    .then(() => {
      const ts = Math.floor(Date.now() / 1000);
      pushEvent(channelOf(entry), {
        kind: "aura_snapshot",
        file_path: filePath,
        ts,
        turn_id: ev.turn_id,
      });
    })
    .catch(() => {
      // Snapshot failures usually mean the file isn't tracked yet — not
      // worth a bubble. The pre-commit hook will still flag missing
      // intent at commit time.
    });

  // Option 2 — bind this file path to the most recent agent_prompt
  // intent. `runAgentPrompt` logs the prompt as intent at send time with
  // an empty changeset; we extend that changeset here as Edit/Write/
  // MultiEdit tool_uses fire. Fire-and-forget — failures (no intent log
  // yet, attribute miss) don't change the user-visible flow.
  api.auraIntentAttribute(repoRoot, [filePath]).catch(() => {});

  // B2 — schedule a watchdog. If no intent for this file lands within
  // WATCHDOG_MS, push a synthetic `aura_warning` event.
  const startedAt = Date.now();
  const timeoutId = window.setTimeout(() => {
    fireWatchdog(entry, ev.id);
  }, WATCHDOG_MS);
  entry.pendingTools.set(ev.id, {
    name: ev.name,
    filePath,
    startedAt,
    turnId: ev.turn_id,
    timeoutId,
  });
}

function channelOf(entry: Entry): string {
  // Reverse-lookup so the snapshot completion can re-enter pushEvent.
  // Cheap — we only have a handful of live channels at once.
  for (const [k, v] of entries) if (v === entry) return k;
  return "";
}

async function fireWatchdog(entry: Entry, toolUseId: string) {
  const pending = entry.pendingTools.get(toolUseId);
  if (!pending) return;
  entry.pendingTools.delete(toolUseId);
  if (!entry.repoRoot || !entry.agentId) return;

  // Look at the intent log: did anything for this file (or anything at
  // all in the grace window) land since the tool_use started?
  try {
    const all = await api.auraReadIntentLog(entry.repoRoot);
    const cutoff = pending.startedAt - INTENT_GRACE_MS;
    const matched = all.some((row) => {
      const ts = (row.timestamp ?? 0) * 1000;
      if (ts < cutoff) return false;
      // Same agent OR generic match. The intent text often references
      // the file by basename — treat that as a match too.
      const sameAgent = row.agent === entry.agentId;
      const fileMention = pending.filePath
        ? (row.intent ?? "").includes(basename(pending.filePath))
        : false;
      return sameAgent || fileMention;
    });
    if (matched) return;
  } catch {
    // If we can't read the log, err on the side of nagging — better a
    // false-positive amber bubble than a silent miss.
  }

  // Defense-in-depth: if the entry was dropped while the tool was
  // pending, channelOf returns "" — never push into a phantom channel.
  const channel = channelOf(entry);
  if (!channel) return;
  pushEvent(channel, {
    kind: "aura_warning",
    message: pending.filePath
      ? `No intent logged for the edit to \`${basename(pending.filePath)}\`. Call \`aura_log_intent\` to keep the audit trail.`
      : `No intent logged for the last tool use. Call \`aura_log_intent\` to keep the audit trail.`,
    file_path: pending.filePath,
    tool_use_id: toolUseId,
    turn_id: pending.turnId,
  });
}
function cancelAllWatchdogs(entry: Entry) {
  for (const t of entry.pendingTools.values()) {
    window.clearTimeout(t.timeoutId);
  }
  entry.pendingTools.clear();
}

/** Pin repo root + agent id on a channel so the store can read the
 *  intent log and dispatch snapshots from inside applyEvent. The
 *  channel string itself sanitizes `/` so we can't recover the real
 *  paths from it — the App-level dispatch site (runAgentPrompt) calls
 *  this once whenever it kicks off a turn. Also stamps
 *  `sessionStartedAt` so the watchdog knows the scan window. */
export function bindChannelMeta(
  channel: string,
  meta: { agentId: string; repoRoot: string },
) {
  const entry = ensureEntry(channel);
  entry.agentId = meta.agentId;
  entry.repoRoot = meta.repoRoot;
  if (!entry.sessionStartedAt) entry.sessionStartedAt = Date.now();
}

/** Read pinned channel meta. Returns null fields if the channel hasn't
 *  been bound yet (no prompt sent). Used by the session-memory hook so
 *  the chip can poll the intent log + snapshots filtered to *this*
 *  agent + session window. */
export function getChannelMeta(channel: string): {
  agentId: string | null;
  repoRoot: string | null;
  sessionStartedAt: number | null;
} {
  const e = entries.get(channel);
  if (!e)
    return { agentId: null, repoRoot: null, sessionStartedAt: null };
  return {
    agentId: e.agentId,
    repoRoot: e.repoRoot,
    sessionStartedAt: e.sessionStartedAt,
  };
}

/** Snapshot the channel's event log without subscribing — used by the
 *  strict-mode commit guard which needs to walk tool_uses once at the
 *  moment of commit. */
export function getChannelEvents(channel: string): StreamEvent[] {
  return entries.get(channel)?.state.events ?? [];
}

/** Snapshot every live stream channel's running / has-events flags without
 *  subscribing. The HUD publisher reads this on a tick to build the fleet
 *  roster + per-status counts — it can't call `useAgentStream` once per
 *  agent. Keyed by channel (`streamChannel(agentId, repoRoot)`). */
export function getAllStreamStates(): Map<string, { running: boolean; hasEvents: boolean }> {
  const out = new Map<string, { running: boolean; hasEvents: boolean }>();
  for (const [channel, e] of entries) {
    out.set(channel, { running: e.state.running, hasEvents: e.state.events.length > 0 });
  }
  return out;
}

/** Reactive whole-fleet stream status — re-renders the caller whenever ANY
 *  channel's running/events change, without subscribing per channel.
 *  Event-driven (no timer) so it survives the main window being hidden. */
export function useAllStreamStates(): Map<string, { running: boolean; hasEvents: boolean }> {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    globalSubs.add(fn);
    return () => {
      globalSubs.delete(fn);
    };
  }, []);
  return getAllStreamStates();
}

async function attach(channel: string, entry: Entry, gen: number) {
  console.log("[agent-stream] attaching listener for", channel);
  // Two listeners: one for events, one for the done sentinel. They
  // resolve independently — store each as soon as it lands so we don't
  // lose the events listener if the done listener is slow.
  const evUn = await listen<StreamEvent>(
    `agent-stream:${channel}`,
    (e) => {
      console.log("[agent-stream]", channel, "←", e.payload.kind, e.payload);
      applyEvent(entry, e.payload);
    },
  );
  // If a stale generation tries to install a listener, drop it on the
  // floor — a newer attach has already taken over.
  if (entry.gen !== gen) {
    evUn();
    return;
  }
  if (entry.unlistenStream) entry.unlistenStream();
  entry.unlistenStream = evUn;

  const doneUn = await listen<StreamExitInfo>(
    `agent-stream-done:${channel}`,
    () => {
      if (entry.state.running) {
        entry.state = { ...entry.state, running: false };
        emit(entry);
      }
    },
  );
  if (entry.gen !== gen) {
    doneUn();
    return;
  }
  if (entry.unlistenDone) entry.unlistenDone();
  entry.unlistenDone = doneUn;
}

// How long to keep an idle entry (no React subscribers) before
// dropping it from the entries Map. Closing a tab cycles through the
// cleanup path many times during a session, so cached events should
// survive a quick close+reopen — but a tab that stays closed for
// >5min is gone for good and we'd rather reclaim the heap than carry
// its transcript indefinitely.
const IDLE_DROP_MS = 5 * 60_000;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function detach(channel: string, entry: Entry) {
  if (entry.subs.size > 0) return;
  // Bumping gen invalidates any in-flight attach() so its late-arriving
  // listener Promise can self-clean instead of installing a zombie.
  entry.gen += 1;
  if (entry.unlistenStream) {
    entry.unlistenStream();
    entry.unlistenStream = null;
  }
  if (entry.unlistenDone) {
    entry.unlistenDone();
    entry.unlistenDone = null;
  }
  const prior = idleTimers.get(channel);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    idleTimers.delete(channel);
    const cur = entries.get(channel);
    if (!cur || cur.subs.size > 0) return;
    // Cancel any still-pending intent watchdogs before dropping the
    // entry. Without this, closing a tab mid-tool leaves the 30s
    // setTimeout handles alive; when one fires after the entry is gone,
    // `channelOf` can't find it and pushEvent("") would mint a phantom
    // "" channel. The explicit-close path (forgetAgentStream) already
    // does this; the idle-drop path needs it too.
    cancelAllWatchdogs(cur);
    entries.delete(channel);
  }, IDLE_DROP_MS);
  idleTimers.set(channel, timer);
}

export function useAgentStream(
  channel: string | null,
): StreamSessionState {
  const [, force] = useState(0);

  useEffect(() => {
    if (!channel) return;
    // Re-mounting cancels any pending idle drop scheduled by a prior
    // detach — otherwise a quick close+reopen could lose the cached
    // events mid-flight.
    const pending = idleTimers.get(channel);
    if (pending) {
      clearTimeout(pending);
      idleTimers.delete(channel);
    }
    const entry = ensureEntry(channel);
    const fn = () => force((n) => n + 1);
    entry.subs.add(fn);
    // Capture gen so a late attach knows whether the world has moved
    // on and it should self-clean instead of installing a stale listener.
    if (!entry.unlistenStream) {
      const gen = entry.gen;
      attach(channel, entry, gen).catch(() => {});
    }
    return () => {
      entry.subs.delete(fn);
      detach(channel, entry);
    };
  }, [channel]);

  if (!channel) return { events: [], sessionId: null, running: false, resumedSession: null };
  const entry = entries.get(channel);
  return entry?.state ?? { events: [], sessionId: null, running: false, resumedSession: null };
}

/** Subscribe to the active permission mode for a channel. Used by the
 *  stream surface header pill so the active mode re-renders whenever
 *  setPermissionMode flips it. */
export function usePermissionMode(channel: string | null): PermissionMode {
  const [, force] = useState(0);
  useEffect(() => {
    if (!channel) return;
    const entry = ensureEntry(channel);
    const fn = () => force((n) => n + 1);
    entry.subs.add(fn);
    return () => {
      entry.subs.delete(fn);
    };
  }, [channel]);
  if (!channel) return "default";
  return entries.get(channel)?.permissionMode ?? "default";
}

/** Read the current resume session id without subscribing. Used by the
 *  Composer dispatch path to pass `--resume <sid>` on follow-up turns. */
export function getResumeSession(channel: string): string | null {
  return entries.get(channel)?.state.sessionId ?? null;
}

/** Pin a specific Claude session as the next resume target. Used by
 *  ResumeDialog when the user picks a past conversation — the next
 *  prompt sent in this channel fires with --resume <id>, and the full
 *  ClaudeSession metadata becomes available to the UI for rendering
 *  the session-info card at the top of the bubble view. */
export function setResumeSession(channel: string, session: ClaudeSession) {
  const entry = ensureEntry(channel);
  entry.state = {
    ...entry.state,
    sessionId: session.session_id,
    resumedSession: session,
  };
  emit(entry);
  persistLastSession(channel, session);
}

/** Drop the persisted last-session marker for a channel — call on
 *  /clear so a restart doesn't reopen the conversation the user just
 *  asked to forget. */
export function forgetPersistedSession(channel: string) {
  try {
    localStorage.removeItem(persistKey(channel));
  } catch {
    /* ignore */
  }
}

function persistKey(channel: string): string {
  return `aura.lastSession.${channel}`;
}

export function persistLastSession(channel: string, session: ClaudeSession) {
  try {
    localStorage.setItem(
      persistKey(channel),
      JSON.stringify({
        session_id: session.session_id,
        file_path: session.file_path,
        agent_id: channel.split("@")[0] ?? "claude",
        ts: Date.now(),
      }),
    );
  } catch {
    /* quota — ignore */
  }
}

// Lightweight variant — persists just the session id when system_init
// fires for a fresh conversation we have no full ClaudeSession metadata
// for. The renderer treats `file_path: ""` as "ask the backend later"
// and the resume dispatch path only needs the id.
function persistLastSessionId(entry: Entry, sessionId: string) {
  const channel = channelFromEntry(entry);
  if (!channel) return;
  try {
    localStorage.setItem(
      persistKey(channel),
      JSON.stringify({
        session_id: sessionId,
        file_path: "",
        agent_id: entry.agentId ?? channel.split("@")[0] ?? "claude",
        ts: Date.now(),
      }),
    );
  } catch {
    /* quota — ignore */
  }
}

// Reverse-lookup the channel string for a given entry — we don't store
// it on the entry struct, so walk the registry. Cheap: registry is at
// most ~5 entries on a typical workstation.
function channelFromEntry(entry: Entry): string | null {
  for (const [k, v] of entries.entries()) {
    if (v === entry) return k;
  }
  return null;
}

/** Read the persisted last-session marker for a channel. Returns null
 *  when no session has been pinned yet (or the marker was cleared). */
export function readPersistedSession(channel: string): {
  session_id: string;
  file_path: string;
  agent_id: string;
} | null {
  try {
    const raw = localStorage.getItem(persistKey(channel));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.session_id === "string" &&
      typeof parsed?.file_path === "string" &&
      typeof parsed?.agent_id === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Replace the channel's event log with a pre-built history (typically
 *  from `claudeLoadSession` after the user picks a session to resume).
 *  Resets `running` since loaded events are settled history, not a
 *  live in-flight turn. Keeps `resumedSession` + `sessionId` so the
 *  follow-up turn can still pass `--resume <sid>`. */
export function setResumedHistory(channel: string, events: StreamEvent[]) {
  const entry = ensureEntry(channel);
  entry.state = {
    ...entry.state,
    events,
    running: false,
  };
  emit(entry);
}

/** Get the resumed-session metadata if the user has explicitly picked
 *  one via /resume. Returns null if the channel is on a fresh thread
 *  or only knows the id (e.g. from system_init on a new conversation). */
export function getResumedSession(channel: string): ClaudeSession | null {
  return entries.get(channel)?.state.resumedSession ?? null;
}

/** Mark a turn as in-flight. Called from the dispatch site so the UI
 *  can show a typing indicator immediately (don't wait for the first
 *  byte). The matching `result` or done event flips it back off. */
export function markTurnStarted(channel: string) {
  const entry = ensureEntry(channel);
  if (!entry.state.running) {
    entry.state = { ...entry.state, running: true };
    emit(entry);
  }
}

/** Drop all cached state for a channel. Call when the user explicitly
 *  resets or closes the agent tab so the next open starts clean. */
export function forgetAgentStream(channel: string) {
  const e = entries.get(channel);
  if (e?.unlistenStream) e.unlistenStream();
  if (e?.unlistenDone) e.unlistenDone();
  if (e) cancelAllWatchdogs(e);
  entries.delete(channel);
}
