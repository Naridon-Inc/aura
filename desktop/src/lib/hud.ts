// Shared contract between the floating HUD window (`components/hud/HudApp`)
// and its publisher in the main window (`lib/hudPublisher`).
//
// Each OS window has its own JS heap, so the HUD can't read the main
// window's stores. Instead the main window derives a small snapshot from
// its existing chat/agent stores and broadcasts it on the app-global Tauri
// event bus; the HUD listens and renders. Quick-send travels back the same
// way. Keeping the payloads tiny + serialisable is the whole point — this
// is metadata about the active conversation, never the full transcript.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ApprovalPolicy, ReasoningEffort } from "./api";

/** The four composer modes the HUD's mode chip offers — parity with
 *  ManagerComposer's `ComposerMode`. */
export type HudComposerMode = "auto" | "plan" | "build" | "ask";

/** Main window → HUD: the current glanceable snapshot. */
export const HUD_STATE_EVENT = "hud:state";
/** HUD → main window: send this text to the active conversation. */
export const HUD_SEND_EVENT = "hud:send";
/** HUD → main window: "I just opened, please re-emit current state." */
export const HUD_REQUEST_STATE_EVENT = "hud:request-state";
/** HUD → main window: switch the active project to this root. */
export const HUD_SELECT_PROJECT_EVENT = "hud:select-project";
/** HUD → main window: point the glance at this roster agent (click-through).
 *  The publisher honours it while nothing else needs the user; a fresh
 *  attention event still auto-jumps over it. */
export const HUD_FOCUS_AGENT_EVENT = "hud:focus-agent";

export type HudStatusKind =
  | "idle"
  | "thinking" // working, no finer detail
  | "running" // working, with an activity phrase
  | "awaiting_input" // blocked on the user (permission / pending question)
  | "done"
  | "error";

/** Where a HUD send should land. The publisher computes it; the HUD echoes
 *  it back unchanged so the main window routes through its real dispatcher. */
export type HudTarget =
  | {
      kind: "agent";
      agentId: string;
      agentLabel: string;
      repoRoot: string;
      mode: "stream" | "pty" | "chat";
      /** The open tab's session id. For a PTY agent this is the live handle —
       *  the receiver sends the reply straight to it instead of opening a fresh
       *  terminal, so a quick-reply CONTINUES the session you're glancing at. */
      sessionId: string;
    }
  | { kind: "native"; repoRoot: string };

export type HudMessage = {
  text: string;
  /** Unix seconds. */
  at: number;
  /** True while the agent is still streaming this message. */
  partial?: boolean;
};

/** One entry in the HUD's project-switcher dropdown. */
export type HudProject = {
  root: string;
  /** Short display name (`humanizeWorkspaceName`). */
  name: string;
};

/** One agent/session in the active project's fleet — drives the per-status
 *  counts under the pill and the click-through switcher. The glance follows
 *  whichever entry is `shownKey`. */
export type HudAgentEntry = {
  /** Stable id: an agent tab's `sessionId`, or `native:<root>` for Aura chat.
   *  Also the value the HUD echoes back in `hud:focus-agent`. */
  key: string;
  /** Display label (agent name, or "Aura"). */
  label: string;
  /** Brand-icon id: the coding-agent's id, or `aura-manager` for native. */
  agentId: string;
  status: HudStatusKind;
};

export type HudState = {
  /** Null = nothing active → the HUD shows an idle "what can I help with"
   *  bar that defaults sends to the project's native Aura chat. */
  target: HudTarget | null;
  /** Short label for the active conversation (agent name, or "Aura"). */
  title: string;
  status: HudStatusKind;
  /** Human phrase: "Editing api.ts", "Waiting for your approval", "Idle". */
  statusText: string;
  lastUser: HudMessage | null;
  lastAgent: HudMessage | null;
  /** Whether the composer should accept input + send right now. */
  canSend: boolean;
  /** Projects the user can switch to from the dropdown (recents). */
  projects: HudProject[];
  /** Root of the project the snapshot is for (the dropdown's current value). */
  activeRoot: string | null;
  /** Every agent/session in the active project + its live status — feeds the
   *  per-status counts and the click-through switcher. */
  agents: HudAgentEntry[];
  /** Which roster entry the glance is currently showing (auto-jumps to an
   *  agent that needs the user; else the active desktop session). */
  shownKey: string | null;
};

/** Per-turn composer config carried alongside a HUD send — parity with the
 *  ManagerComposer chips. Native (Aura chat) targets thread these into
 *  `brain_chat_turn`; coding-agent (PTY/stream) targets ignore the brain-only
 *  knobs. All optional → a bare quick-send stays byte-identical. */
export type HudComposerConfig = {
  mode?: HudComposerMode;
  effort?: ReasoningEffort | null;
  fast?: boolean;
  approval?: ApprovalPolicy | null;
  /** `ChatRequest.model` — null keeps the brain's default. */
  model?: string | null;
  /** The model picker's "1M" rows. */
  longContext?: boolean;
  /** Engine override for this turn (a BrainChoice id), or null for the active brain. */
  brainId?: string | null;
};

export type HudSendPayload = { text: string; target: HudTarget | null } & HudComposerConfig;
export type HudSelectProjectPayload = { root: string };
export type HudFocusAgentPayload = { key: string };

export const HUD_IDLE_STATE: HudState = {
  target: null,
  title: "Aura",
  status: "idle",
  statusText: "Idle",
  lastUser: null,
  lastAgent: null,
  canSend: true,
  projects: [],
  activeRoot: null,
  agents: [],
  shownKey: null,
};

// ── Typed emit / listen wrappers ────────────────────────────────────────

export function emitHudState(state: HudState): Promise<void> {
  return emit(HUD_STATE_EVENT, state);
}

export function onHudState(cb: (s: HudState) => void): Promise<UnlistenFn> {
  return listen<HudState>(HUD_STATE_EVENT, (e) => cb(e.payload));
}

export function emitHudSend(payload: HudSendPayload): Promise<void> {
  return emit(HUD_SEND_EVENT, payload);
}

export function onHudSend(cb: (p: HudSendPayload) => void): Promise<UnlistenFn> {
  return listen<HudSendPayload>(HUD_SEND_EVENT, (e) => cb(e.payload));
}

export function requestHudState(): Promise<void> {
  return emit(HUD_REQUEST_STATE_EVENT);
}

export function onRequestHudState(cb: () => void): Promise<UnlistenFn> {
  return listen(HUD_REQUEST_STATE_EVENT, () => cb());
}

export function emitHudSelectProject(payload: HudSelectProjectPayload): Promise<void> {
  return emit(HUD_SELECT_PROJECT_EVENT, payload);
}

export function onHudSelectProject(
  cb: (p: HudSelectProjectPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudSelectProjectPayload>(HUD_SELECT_PROJECT_EVENT, (e) => cb(e.payload));
}

export function emitHudFocusAgent(payload: HudFocusAgentPayload): Promise<void> {
  return emit(HUD_FOCUS_AGENT_EVENT, payload);
}

export function onHudFocusAgent(
  cb: (p: HudFocusAgentPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudFocusAgentPayload>(HUD_FOCUS_AGENT_EVENT, (e) => cb(e.payload));
}

// ── Full-response reader (request/response round-trip) ──────────────────
// The steady `hud:state` snapshot is glance-only (a ~50-char gist) by design.
// To read the agent's COMPLETE last message, the HUD asks for it on demand and
// the publisher — which still holds the un-summarised strings — replies. Keying
// both on `shownKey` guards against a stale reply landing after the glance has
// already jumped to a different conversation.

/** HUD → main: "send me the full user+agent text for this conversation." */
export const HUD_REQUEST_FULL_EVENT = "hud:request-full";
/** main → HUD: the full text for `shownKey` (either side may be empty). */
export const HUD_FULL_MESSAGE_EVENT = "hud:full-message";

export type HudRequestFullPayload = { shownKey: string };
export type HudFullMessagePayload = {
  shownKey: string;
  user: string;
  agent: string;
};

export function emitHudRequestFull(payload: HudRequestFullPayload): Promise<void> {
  return emit(HUD_REQUEST_FULL_EVENT, payload);
}

export function onHudRequestFull(
  cb: (p: HudRequestFullPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudRequestFullPayload>(HUD_REQUEST_FULL_EVENT, (e) => cb(e.payload));
}

export function emitHudFullMessage(payload: HudFullMessagePayload): Promise<void> {
  return emit(HUD_FULL_MESSAGE_EVENT, payload);
}

export function onHudFullMessage(
  cb: (p: HudFullMessagePayload) => void,
): Promise<UnlistenFn> {
  return listen<HudFullMessagePayload>(HUD_FULL_MESSAGE_EVENT, (e) => cb(e.payload));
}

// ── Conversation history (request/response round-trip) ──────────────────
// The Sidebar mode is a tall panel with room for more than the last exchange:
// it shows a scrollable thread of recent turns, each with its time-taken + a
// copy action (parity with the in-app Aura chat). Like the reader, the steady
// snapshot stays glance-only — the HUD asks for the thread on demand and the
// publisher (which holds the full turn list) replies, keyed on `shownKey`.

/** One turn in the HUD's sidebar thread. */
export type HudTurn = {
  role: "user" | "agent";
  /** Full (un-summarised) turn text — the panel renders it as markdown. */
  text: string;
  /** Unix seconds. */
  at: number;
  /** Reply time-taken in seconds (agent turns only): the gap to the prompt it
   *  answered. Null when unknown or not applicable. */
  durationSec?: number | null;
};

/** HUD → main: "send me the recent turn thread for this conversation." */
export const HUD_REQUEST_HISTORY_EVENT = "hud:request-history";
/** main → HUD: the recent turns for `shownKey` (oldest → newest). */
export const HUD_HISTORY_EVENT = "hud:history";

export type HudRequestHistoryPayload = { shownKey: string };
export type HudHistoryPayload = { shownKey: string; turns: HudTurn[] };

export function emitHudRequestHistory(payload: HudRequestHistoryPayload): Promise<void> {
  return emit(HUD_REQUEST_HISTORY_EVENT, payload);
}

export function onHudRequestHistory(
  cb: (p: HudRequestHistoryPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudRequestHistoryPayload>(HUD_REQUEST_HISTORY_EVENT, (e) => cb(e.payload));
}

export function emitHudHistory(payload: HudHistoryPayload): Promise<void> {
  return emit(HUD_HISTORY_EVENT, payload);
}

export function onHudHistory(cb: (p: HudHistoryPayload) => void): Promise<UnlistenFn> {
  return listen<HudHistoryPayload>(HUD_HISTORY_EVENT, (e) => cb(e.payload));
}

// ── Presentation mode + opacity (Settings → HUD live) ───────────────────
// The HUD's shape is a setting. The main window persists it (settingsStore →
// settings.toml) and broadcasts the change; the HUD applies it window-side
// (CSS via `data-hud-mode` + the native `hud_set_mode`/`hud_set_opacity`).

/** The HUD shapes — mirror of Rust's `hud::Mode`. */
export type HudPresentationMode = "capsule" | "sidebar" | "minimal" | "ambient";

/** main → HUD: presentation mode / opacity / sidebar dims changed in Settings. */
export const HUD_SETTINGS_EVENT = "hud:settings";

export type HudSettingsPayload = {
  mode: HudPresentationMode;
  opacity: number;
  /** Sidebar panel content size in px — the HUD turns these into CSS vars. */
  sidebarWidth: number;
  sidebarHeight: number;
  /** Whether the desk-pet perches on the pill. Optional so older emitters
   *  (pre-pet) still typecheck; the HUD only reacts when it's a boolean. */
  pet?: boolean;
};

export function emitHudSettings(payload: HudSettingsPayload): Promise<void> {
  return emit(HUD_SETTINGS_EVENT, payload);
}

export function onHudSettings(
  cb: (p: HudSettingsPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudSettingsPayload>(HUD_SETTINGS_EVENT, (e) => cb(e.payload));
}

// ── Composer enum pickers (mode / effort / approvals / brain·model) ──
// The HUD composer's chips can't use a Radix dropdown — a body-portal is clipped
// to the tiny HUD window. They pop a NATIVE NSMenu (`hud_menu` in hud.rs) which
// floats over fullscreen, and a pick routes back through this event carrying the
// chip `kind` + chosen `id` so the HUD knows which chip changed and to what.

/** Native NSMenu pick → HUD: which composer chip changed, and to what value. */
export const HUD_MENU_PICK_EVENT = "hud:menu-pick";

/** Which composer chip a native menu belongs to. */
export type HudMenuKind = "mode" | "effort" | "approval" | "brain";

/** One row handed to the native composer menu. An empty `id` with no `children`
 *  renders as a disabled section header; `children` nest one level (the brain
 *  picker uses it to group each engine's models). */
export type HudMenuRow = {
  id: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  children?: HudMenuRow[];
};

export type HudMenuPickPayload = { kind: HudMenuKind; id: string };

/** Pop a native composer menu of `kind` at screen point (x, y). The pick comes
 *  back via {@link onHudMenuPick}. */
export function openHudMenu(
  kind: HudMenuKind,
  items: HudMenuRow[],
  x: number,
  y: number,
): Promise<void> {
  return invoke("hud_menu", { kind, items, x, y });
}

export function onHudMenuPick(
  cb: (p: HudMenuPickPayload) => void,
): Promise<UnlistenFn> {
  return listen<HudMenuPickPayload>(HUD_MENU_PICK_EVENT, (e) => cb(e.payload));
}
