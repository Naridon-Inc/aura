// Headless component that lives in the MAIN window and feeds the floating
// HUD. It reuses the app's existing chat/agent stores (no new plumbing) to
// derive a tiny `HudState` snapshot for whatever conversation is active,
// and broadcasts it on the Tauri event bus the HUD window listens to.
//
// "Active conversation" resolution (v1, deliberately predictable):
//   1. the active CODING-AGENT tab (editorStore.activeAgentId), else
//   2. the project's ambient NATIVE Aura chat session, else
//   3. nothing → an idle "what can I help with" bar.
//
// It renders null — it's a subscriber, not UI. Mount exactly one per app
// (the real main window only, never a workspace popout, or two publishers
// would fight over `hud:state`).

import { useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { liveActivityText } from "./agentActivity";
import { useAgentEvent, useAllAgentStatuses } from "./agentEventStore";
import { streamChannel, useAgentStream, useAllStreamStates } from "./agentStreamStore";
import {
  api,
  type CliAgentStatus,
  type PrerollTurn,
  type StreamEvent,
} from "./api";
import type { AgentTab } from "./editorStore";
import { useEditorStore } from "./editorStore";
import { FOCUS_MANAGER_EVENT, type FocusManagerDetail } from "./focusManager";
import {
  emitHudFullMessage,
  emitHudHistory,
  emitHudState,
  HUD_IDLE_STATE,
  type HudAgentEntry,
  type HudMessage,
  type HudProject,
  type HudState,
  type HudStatusKind,
  type HudTarget,
  type HudTurn,
  onHudFocusAgent,
  onHudRequestFull,
  onHudRequestHistory,
  onRequestHudState,
} from "./hud";
import {
  isManagerTurnInFlight,
  useManagerSession,
  useManagerSummaries,
} from "./managerStore";
import { stripSteeringDirective } from "./steeringDirective";
import { humanizeWorkspaceName } from "./workspaceLabel";

type NativeSession = NonNullable<ReturnType<typeof useManagerSession>>;

const MAX_MSG = 300;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function trim(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_MSG ? `${one.slice(0, MAX_MSG - 1)}…` : one;
}

// Conversational lead-ins the glance shouldn't waste its one line on — so it
// reads "Fixed the auth bug" instead of being stuck on "Sure, let me…".
const FILLER =
  /^(?:sure|okay|ok|alright|right|certainly|of course|got it|gotcha|yes|yep|yeah|hmm+|let me|let's|i'?ll|i will|i'?m going to|i am going to|i'?m gonna|here'?s|here is|now|so|well|great|perfect|absolutely|thanks?|thank you)\b[\s,!.:—-]*/i;

// A one-line *summary* of an agent message for the HUD glance — not the raw
// first line. Strips markdown/code/tool noise, drops a filler preamble, then
// keeps enough leading sentences to convey the gist (~50 chars), capped to one
// readable line. Cheap + synchronous (no model call) so it tracks the stream.
function summarizeLine(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code → its contents
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label
    .replace(/^[ \t]*(?:[#>]+|[-*+]|\d+[.)])[ \t]+/gm, "") // headings / list bullets
    .replace(/[*_~]{1,3}/g, "") // emphasis markers
    .replace(/\s+/g, " ")
    .trim();
  // Peel up to a few chained preambles ("Sure, let me…").
  for (let i = 0; i < 3 && FILLER.test(t); i++) t = t.replace(FILLER, "").trim();
  // Stripping can empty out a short ack ("Got it!"), a pure code-block reply, or
  // a filler-only line. NEVER return "" for a non-empty message — that blanks
  // the HUD glance (its `?? status` fallback doesn't catch an empty string). Fall
  // back to the whitespace-collapsed original so the glance shows real words.
  if (!t) return trim(text);
  const sentences = (t.match(/[^.!?]+[.!?]*/g) ?? [t]).map((s) => s.trim()).filter(Boolean);
  let out = "";
  for (const s of sentences) {
    out = out ? `${out} ${s}` : s;
    if (out.length >= 50) break; // enough to be a gist, not a fragment
  }
  if (!out) out = t;
  return out.length > MAX_MSG ? `${out.slice(0, MAX_MSG - 1)}…` : out;
}

function readAmbient(root: string | null): string | null {
  if (!root) return null;
  try {
    return localStorage.getItem(`aura.ambient.${root}`);
  } catch {
    return null;
  }
}

function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

/** Recent projects for the HUD's switcher dropdown — same `aura.recents` list
 *  the in-app WorkspaceSwitcher uses, with the active root pinned first. */
function readProjects(activeRoot: string | null): HudProject[] {
  let roots: string[] = [];
  try {
    const raw = localStorage.getItem("aura.recents");
    if (raw) roots = JSON.parse(raw) as string[];
  } catch {
    roots = [];
  }
  if (activeRoot && !roots.some((r) => sameRoot(r, activeRoot))) {
    roots = [activeRoot, ...roots];
  }
  const seen = new Set<string>();
  const out: HudProject[] = [];
  for (const r of roots) {
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push({ root: r, name: humanizeWorkspaceName(r) });
    if (out.length >= 8) break;
  }
  return out;
}

// ── derivation helpers ──────────────────────────────────────────────────

/** Last user + last (fully-assembled) agent message from a stream tab. */
function streamMessages(
  events: StreamEvent[],
  running: boolean,
): { user: HudMessage | null; agent: HudMessage | null } {
  let user: HudMessage | null = null;
  let lastTurn: string | null = null;
  for (const e of events) {
    if (e.kind === "user_prompt") user = { text: trim(e.text), at: e.ts ?? nowSec() };
    else if (e.kind === "assistant_text") lastTurn = e.turn_id ?? lastTurn;
  }
  let text = "";
  for (const e of events) {
    if (e.kind === "assistant_text" && (e.turn_id ?? null) === lastTurn) text += e.text;
  }
  const agent = text
    ? { text: summarizeLine(text), at: user?.at ?? nowSec(), partial: running }
    : null;
  return { user, agent };
}

/** Raw (un-summarised) last user + last-turn agent text from a stream tab — the
 *  body the full-response reader shows. Mirrors `streamMessages` without the
 *  gist/trim so the reader gets the complete reply. */
function streamFull(events: StreamEvent[]): { user: string; agent: string } {
  let user = "";
  let lastTurn: string | null = null;
  for (const e of events) {
    if (e.kind === "user_prompt") user = e.text;
    else if (e.kind === "assistant_text") lastTurn = e.turn_id ?? lastTurn;
  }
  let agent = "";
  for (const e of events) {
    if (e.kind === "assistant_text" && (e.turn_id ?? null) === lastTurn) agent += e.text;
  }
  return { user, agent };
}

function streamStatus(
  events: StreamEvent[],
  running: boolean,
): { status: HudStatusKind; statusText: string } {
  if (running) return { status: "thinking", statusText: "Working…" };
  if (events.length > 0) return { status: "idle", statusText: "Idle" };
  return { status: "idle", statusText: "Idle" };
}

/** PTY/interactive agents surface their state through the OSC-777 hook
 *  stream (`useAgentEvent`), which carries query/response on completion and
 *  a live activity phrase mid-turn. */
function ptyDerive(
  st: CliAgentStatus,
  phrase: string | null,
): { status: HudStatusKind; statusText: string; user: HudMessage | null; agent: HudMessage | null } {
  switch (st.kind) {
    case "in_progress":
      return {
        status: phrase ? "running" : "thinking",
        statusText: phrase ?? "Working…",
        user: null,
        agent: phrase ? { text: phrase, at: nowSec(), partial: true } : null,
      };
    case "blocked":
      return {
        status: "awaiting_input",
        statusText: st.summary ? trim(st.summary) : "Waiting for you",
        user: null,
        agent: st.summary ? { text: trim(st.summary), at: nowSec() } : null,
      };
    case "success":
      return {
        status: "done",
        statusText: "Done",
        user: st.query ? { text: trim(st.query), at: nowSec() } : null,
        agent: st.response ? { text: summarizeLine(st.response), at: nowSec() } : null,
      };
    case "idle":
    default:
      return { status: "idle", statusText: "Idle", user: null, agent: null };
  }
}

// ── fleet roster helpers ────────────────────────────────────────────────

/** Roster key for a project's ambient native Aura chat (one per project). */
function nativeKey(root: string): string {
  return `native:${root}`;
}

function cliToKind(st: CliAgentStatus): HudStatusKind {
  switch (st.kind) {
    case "in_progress":
      return "thinking";
    case "blocked":
      return "awaiting_input";
    case "success":
      return "done";
    default:
      return "idle";
  }
}

/** A single tab's coarse status for the roster — read from the whole-fleet
 *  store snapshots (no per-tab hook). `attention` (backend says it's waiting on
 *  you) trumps everything; PTY/chat read the event store, stream reads the
 *  running flag. */
function tabStatus(
  tab: AgentTab,
  streamStates: Map<string, { running: boolean; hasEvents: boolean }>,
  ptyStatuses: Map<string, CliAgentStatus>,
): HudStatusKind {
  if (tab.attention) return "awaiting_input";
  if (tab.mode === "stream") {
    const s = streamStates.get(streamChannel(tab.agentId, tab.repoRoot));
    return s?.running ? "thinking" : "idle";
  }
  const st = ptyStatuses.get(tab.sessionId);
  return st ? cliToKind(st) : "idle";
}

/** Native session → HUD status (the canonical precedence: pending question →
 *  approval → running → completed → idle). */
function nativeStatusKind(
  session: NativeSession | null,
  busy: boolean,
): { status: HudStatusKind; statusText: string } {
  if (!session) return { status: "idle", statusText: "Idle" };
  if (session.pending_question)
    return { status: "awaiting_input", statusText: "Waiting for your answer" };
  if (session.status === "awaiting_approval")
    return { status: "awaiting_input", statusText: "Waiting for your approval" };
  if (busy || session.status === "running")
    return { status: "thinking", statusText: "Thinking…" };
  if (session.status === "completed") return { status: "done", statusText: "Done" };
  return { status: "idle", statusText: "Idle" };
}

/** Last user + last agent message from a native session's chat log. */
function nativeMessages(session: NativeSession): {
  user: HudMessage | null;
  agent: HudMessage | null;
} {
  let user: HudMessage | null = null;
  let agentTurn: { text: string; at: number } | null = null;
  for (const t of session.chat ?? []) {
    if (t.role === "user") user = { text: trim(t.text), at: t.at };
    else if (t.role === "manager") agentTurn = { text: t.text, at: t.at };
  }
  const agent: HudMessage | null = agentTurn
    ? { text: summarizeLine(agentTurn.text), at: agentTurn.at }
    : null;
  return { user, agent };
}

/** Raw (un-summarised) last user + last manager text from a native session — the
 *  body the full-response reader shows. */
function nativeFull(session: NativeSession): { user: string; agent: string } {
  let user = "";
  let agent = "";
  for (const t of session.chat ?? []) {
    if (t.role === "user") user = t.text;
    else if (t.role === "manager") agent = t.text;
  }
  return { user, agent };
}

// ── conversation thread (sidebar history) ───────────────────────────────
// The sidebar panel shows a scrollable thread of recent turns, not just the
// last exchange. These build the full turn list (oldest → newest) from each
// source, with per-agent-turn time-taken (the gap to the prompt it answered).

const HISTORY_MAX = 14; // recent turns kept — the panel scrolls; older drops off
const TURN_TEXT_MAX = 8000; // per-turn cap so a long thread stays serialisable

function clampTurn(s: string): string {
  return s.length > TURN_TEXT_MAX ? `${s.slice(0, TURN_TEXT_MAX - 1)}…` : s;
}

/** A user turn for display: strip the internal mode/pipe directive the composer
 *  prepends (`[AUTO MODE — …]`, `[↪ PIPED …]`) — model-facing wiring, never
 *  shown — then clamp. Empty result ⇒ the turn was directive-only; the caller
 *  drops it so no blank bubble appears. */
function cleanUserTurn(s: string): string {
  return clampTurn(stripSteeringDirective(s).trim());
}

/** Time-taken for an agent turn = gap (s) to the nearest prior turn; null when
 *  unknown or implausibly large (a thread resumed days later isn't "thinking"). */
function gapSec(at: number, priorAt: number): number | null {
  const d = at - priorAt;
  return priorAt > 0 && d >= 0 && d <= 86400 ? d : null;
}

/** Native Aura-chat thread. */
function nativeHistory(session: NativeSession): HudTurn[] {
  const chat = (session.chat ?? []).filter(
    (t) => t.role === "user" || t.role === "manager",
  );
  const turns: HudTurn[] = [];
  for (let i = 0; i < chat.length; i++) {
    const t = chat[i];
    if (t.role === "user") {
      const u = cleanUserTurn(t.text);
      if (u) turns.push({ role: "user", text: u, at: t.at });
    } else {
      turns.push({
        role: "agent",
        text: clampTurn(t.text),
        at: t.at,
        durationSec: i > 0 ? gapSec(t.at, chat[i - 1].at) : null,
      });
    }
  }
  return turns.slice(-HISTORY_MAX);
}

/** Stream-agent thread — reconstructed from the OSC event log, grouped by turn.
 *  Only `user_prompt` carries a timestamp; the per-turn `result` event carries
 *  the reply `duration_ms` (the real time-taken), so we read it from there
 *  rather than diffing timestamps the assistant events don't have. */
function streamHistory(events: StreamEvent[]): HudTurn[] {
  const turns: HudTurn[] = [];
  let curAgent: HudTurn | null = null;
  let curTid: string | null = null;
  let lastUserAt = 0;
  for (const e of events) {
    if (e.kind === "user_prompt") {
      curAgent = null;
      curTid = null;
      lastUserAt = e.ts ?? nowSec();
      const u = cleanUserTurn(e.text);
      if (u) turns.push({ role: "user", text: u, at: lastUserAt });
    } else if (e.kind === "assistant_text") {
      const tid = e.turn_id ?? "_";
      if (!curAgent || curTid !== tid) {
        curTid = tid;
        curAgent = {
          role: "agent",
          text: "",
          at: lastUserAt || nowSec(),
          durationSec: null,
        };
        turns.push(curAgent);
      }
      curAgent.text = clampTurn(curAgent.text + e.text);
    } else if (e.kind === "result" && curAgent && e.turn_id === curTid) {
      curAgent.durationSec = e.duration_ms > 0 ? e.duration_ms / 1000 : null;
    }
  }
  return turns.slice(-HISTORY_MAX);
}

/** PTY-agent thread — from the on-disk preroll (the live heap only holds the
 *  last query/response). `ts` is epoch millis (0 when the source line had none). */
function prerollHistory(pre: PrerollTurn[]): HudTurn[] {
  const rows = pre.filter((t) => t.role === "user" || t.role === "assistant");
  const turns: HudTurn[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const at = t.ts ? Math.floor(t.ts / 1000) : 0;
    if (t.role === "user") {
      const u = cleanUserTurn(t.text);
      if (u) turns.push({ role: "user", text: u, at });
    } else {
      const priorAt = i > 0 && rows[i - 1].ts ? Math.floor(rows[i - 1].ts / 1000) : 0;
      turns.push({
        role: "agent",
        text: clampTurn(t.text),
        at,
        durationSec: gapSec(at, priorAt),
      });
    }
  }
  return turns.slice(-HISTORY_MAX);
}

export function HudPublisher({ projectRoot }: { projectRoot: string | null }): null {
  const editor = useEditorStore();
  // Only an agent tab in the ACTIVE project counts as "what you're on". The
  // editor can hold cross-project agent tabs (e.g. a New Git Claude Code open
  // while the project is simplecrm); without the repoRoot guard that foreign
  // tab would hijack the glance and a quick-reply would spawn a fresh agent in
  // the wrong project instead of going to this project's Aura chat.
  const activeTab = projectRoot
    ? editor.agentTabs.find(
        (t) => t.sessionId === editor.activeAgentId && sameRoot(t.repoRoot, projectRoot),
      ) ?? null
    : null;

  // Ambient native session for this project, kept reactive to the same
  // signals AuraRailPanel uses (focus event + cross-window storage event).
  const [ambientSid, setAmbientSid] = useState<string | null>(() => readAmbient(projectRoot));
  useEffect(() => {
    setAmbientSid(readAmbient(projectRoot));
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<FocusManagerDetail>).detail;
      if (d && projectRoot && sameRoot(d.repoRoot, projectRoot)) setAmbientSid(d.sessionId);
    };
    const onStorage = () => setAmbientSid(readAmbient(projectRoot));
    window.addEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [projectRoot]);

  // Resolve the project's native session: the explicit ambient pointer first,
  // else the most-recently-touched manager session bound to this project. The
  // fallback is what makes the HUD default to "the session you were just in"
  // even when the ambient key hasn't propagated to this window yet (AuraRailPanel
  // writes localStorage without firing a same-window event) — without it the
  // glance sits blank ("—") until the first send.
  const summaries = useManagerSummaries();
  const resolvedNativeSid = useMemo(() => {
    if (ambientSid) return ambientSid;
    if (!projectRoot) return null;
    const mine = summaries
      .filter((s) => s.repo_root && sameRoot(s.repo_root, projectRoot))
      .sort((a, b) => b.updated_at - a.updated_at);
    return mine[0]?.id ?? null;
  }, [ambientSid, projectRoot, summaries]);

  // Manual click-through override: the HUD can point the glance at any roster
  // agent. Honoured only while nothing needs the user (a fresh attention event
  // still auto-jumps over it). Cleared whenever the desktop focus moves, so the
  // HUD snaps back to following the session you're actually in.
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [editor.activeAgentId, resolvedNativeSid]);
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void onHudFocusAgent((p) => setOverride(p.key)).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // Whole-fleet status (reactive + event-driven — survives the main window being
  // hidden behind a fullscreen app). Drives the roster + per-status counts.
  const streamStates = useAllStreamStates();
  const ptyStatuses = useAllAgentStatuses();
  const ambientSession = useManagerSession(resolvedNativeSid);
  const ambientBusy = resolvedNativeSid ? isManagerTurnInFlight(resolvedNativeSid) : false;

  // The active project's fleet: each open agent tab IN THIS PROJECT + the
  // ambient native chat. Foreign-project tabs are excluded so the roster, the
  // per-status counts, and the glance all stay scoped to the project you're in.
  const roster: HudAgentEntry[] = editor.agentTabs
    .filter((t) => projectRoot && sameRoot(t.repoRoot, projectRoot))
    .map((t) => ({
      key: t.sessionId,
      label: t.agentLabel,
      agentId: t.agentId,
      status: tabStatus(t, streamStates, ptyStatuses),
    }));
  if (resolvedNativeSid && projectRoot) {
    roster.push({
      key: nativeKey(projectRoot),
      label: "Aura",
      agentId: "aura-manager",
      status: nativeStatusKind(ambientSession, ambientBusy).status,
    });
  }

  // Which entry the glance shows: the session you're in by default; auto-jump to
  // an agent that needs you (asking / errored) when you aren't already on one;
  // a manual click-through wins only while nothing needs you.
  const focusedKey = activeTab
    ? activeTab.sessionId
    : resolvedNativeSid && projectRoot
      ? nativeKey(projectRoot)
      : null;
  const focusedStatus = roster.find((r) => r.key === focusedKey)?.status;
  const focusedIsAttn = focusedStatus === "awaiting_input" || focusedStatus === "error";
  const attn =
    roster.find((r) => r.status === "awaiting_input") ??
    roster.find((r) => r.status === "error");
  let shownKey: string | null;
  if (attn && !focusedIsAttn) shownKey = attn.key;
  else if (override && roster.some((r) => r.key === override)) shownKey = override;
  else shownKey = focusedKey ?? roster[0]?.key ?? null;

  // Resolve the shown target → an agent tab, else the ambient native chat.
  const shownTab: AgentTab | null =
    shownKey && !shownKey.startsWith("native:")
      ? editor.agentTabs.find(
          (t) => t.sessionId === shownKey && projectRoot && sameRoot(t.repoRoot, projectRoot),
        ) ?? null
      : null;

  // Detail hooks keyed off the SHOWN target (each tolerates null → stable order).
  const shownIsStream = shownTab?.mode === "stream";
  const channel =
    shownTab && shownIsStream ? streamChannel(shownTab.agentId, shownTab.repoRoot) : null;
  const stream = useAgentStream(channel);
  const ptySid = shownTab && !shownIsStream ? shownTab.sessionId : null;
  const evt = useAgentEvent(ptySid);

  const projects = useMemo(() => readProjects(projectRoot), [projectRoot]);

  let state: HudState;
  // The un-summarised body for the SHOWN conversation, stashed for the HUD's
  // full-response reader (delivered on request, not in the steady snapshot).
  let full: { user: string; agent: string } = { user: "", agent: "" };
  // The recent turn thread, for the sidebar's scrollable history. Empty for a
  // PTY agent (its history lives on disk) → the request handler fetches preroll.
  let history: HudTurn[] = [];
  if (shownTab) {
    const target = {
      kind: "agent" as const,
      agentId: shownTab.agentId,
      agentLabel: shownTab.agentLabel,
      repoRoot: shownTab.repoRoot,
      mode: shownTab.mode,
      sessionId: shownTab.sessionId,
    };
    if (shownIsStream) {
      const { user, agent } = streamMessages(stream.events, stream.running);
      const { status, statusText } = streamStatus(stream.events, stream.running);
      full = streamFull(stream.events);
      history = streamHistory(stream.events);
      state = { target, title: shownTab.agentLabel, status, statusText, lastUser: user, lastAgent: agent, canSend: true, projects, activeRoot: projectRoot, agents: roster, shownKey };
    } else {
      const phrase = liveActivityText(evt.title, evt.last);
      const d = ptyDerive(evt.status, phrase);
      const st = evt.status;
      if (st.kind === "success") full = { user: st.query ?? "", agent: st.response ?? "" };
      else if (st.kind === "blocked") full = { user: "", agent: st.summary ?? "" };
      state = { target, title: shownTab.agentLabel, status: d.status, statusText: d.statusText, lastUser: d.user, lastAgent: d.agent, canSend: true, projects, activeRoot: projectRoot, agents: roster, shownKey };
    }
  } else if (ambientSession) {
    const { user, agent } = nativeMessages(ambientSession);
    const { status, statusText } = nativeStatusKind(ambientSession, ambientBusy);
    full = nativeFull(ambientSession);
    history = nativeHistory(ambientSession);
    // When the session is waiting on the user, the glance should show the
    // QUESTION being asked — it lives on `pending_question`, not necessarily as a
    // manager turn in the chat log, so without this the "Needs you" pill is blank.
    const pendingQ = ambientSession.pending_question?.question?.trim();
    const lastAgent =
      status === "awaiting_input" && pendingQ
        ? { text: trim(pendingQ), at: nowSec() }
        : agent;
    state = {
      target: projectRoot ? { kind: "native", repoRoot: projectRoot } : null,
      title: "Aura",
      status,
      statusText,
      lastUser: user,
      lastAgent,
      canSend: true,
      projects,
      activeRoot: projectRoot,
      agents: roster,
      shownKey,
    };
  } else {
    state = {
      ...HUD_IDLE_STATE,
      target: projectRoot ? { kind: "native", repoRoot: projectRoot } : null,
      projects,
      activeRoot: projectRoot,
      agents: roster,
      shownKey,
    };
  }

  // Broadcast on every meaningful change (deduped by serialised value).
  const lastJson = useRef<string>("");
  const stateRef = useRef<HudState>(state);
  stateRef.current = state;
  useEffect(() => {
    const json = JSON.stringify(state);
    if (json === lastJson.current) return;
    lastJson.current = json;
    void emitHudState(state);
  }, [state]);

  // The full body for the shown conversation, kept in a ref so the once-
  // registered request handler always sees the latest without re-subscribing.
  const fullRef = useRef<{
    shownKey: string | null;
    user: string;
    agent: string;
    target: HudTarget | null;
  }>({ shownKey, user: full.user, agent: full.agent, target: state.target });
  fullRef.current = { shownKey, user: full.user, agent: full.agent, target: state.target };

  // The HUD asks for the complete last message on demand (the steady snapshot is
  // glance-only). Reply from the cached full strings; if the agent body is empty
  // — a long coding-agent turn evicted from this window's heap — fall back to the
  // on-disk preroll so the reader still gets the real reply.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void onHudRequestFull(async (p) => {
      const cur = fullRef.current;
      let user = cur.user;
      let agent = cur.agent;
      if (!agent && cur.target?.kind === "agent") {
        try {
          const turns = await api.agentHistoryPreroll(
            cur.target.agentId,
            cur.target.repoRoot,
            cur.target.sessionId,
          );
          const lastAsst = [...turns].reverse().find((t) => t.role === "assistant");
          if (lastAsst) agent = lastAsst.text;
          if (!user) {
            const lastUser = [...turns].reverse().find((t) => t.role === "user");
            if (lastUser) user = lastUser.text;
          }
        } catch {
          /* best-effort; reply with whatever the cache held */
        }
      }
      void emitHudFullMessage({ shownKey: cur.shownKey ?? p.shownKey, user, agent });
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // The recent turn thread for the shown conversation, kept in a ref for the
  // once-registered history handler (same pattern as `fullRef`).
  const historyRef = useRef<{
    shownKey: string | null;
    turns: HudTurn[];
    target: HudTarget | null;
  }>({ shownKey, turns: history, target: state.target });
  historyRef.current = { shownKey, turns: history, target: state.target };

  // The sidebar asks for the thread on demand. Reply from the cached turns; for
  // a PTY agent (empty cache — its log lives on disk) fetch the preroll so the
  // panel shows real history, not just the last exchange.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void onHudRequestHistory(async (p) => {
      const cur = historyRef.current;
      let turns = cur.turns;
      if (turns.length === 0 && cur.target?.kind === "agent") {
        try {
          const pre = await api.agentHistoryPreroll(
            cur.target.agentId,
            cur.target.repoRoot,
            cur.target.sessionId,
          );
          turns = prerollHistory(pre);
        } catch {
          /* best-effort; reply with whatever the cache held */
        }
      }
      void emitHudHistory({ shownKey: cur.shownKey ?? p.shownKey, turns });
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // A freshly-opened HUD asks for the current snapshot so it isn't blank
  // until the next change.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void onRequestHudState(() => {
      void emitHudState(stateRef.current);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // The HUD is summon-only: it appears solely when the user calls it up
  // (⌘⇧A global shortcut, the tray icon, or Settings → Show HUD) and stays put
  // until they dismiss it (Esc / ⌘⇧A). It deliberately does NOT pop itself open
  // on agent activity, nor tuck itself away while an agent works — that
  // unsummoned motion was jarring (the bar appearing on its own). Visibility is
  // the user's to drive; this publisher only keeps the glance content current.

  return null;
}
