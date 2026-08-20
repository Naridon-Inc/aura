// Session Live plane — the wire vocabulary.
//
// Mirrors `docs/collab/SESSION_LIVE_PROTOCOL.md` field-for-field: one
// WebSocket per session carrying the agent transcript between *different
// people*. Types only, no I/O — this is the half of the contract the cloud,
// the desktop and every React surface have to agree on, so it is kept where
// nothing can drag a Tauri import into it.
//
// The load-bearing shape is `msg`: ONE addressable frame covers every
// sender/recipient pairing (human→agent, human→peer's agent, human→human,
// agent→agent, agent→human, broadcast). Delivery is decided by the
// recipient's `kind`, not by the frame type — which is exactly why there is
// no separate `turn` or `agent_say` type to drift apart from it.
//
// Field names are snake_case because they are the server's, not ours.
// Renaming them at the edge would mean every one of these types lies about
// what is actually on the wire.

// ── Protocol vocabulary ──────────────────────────────────────────────────

export type ParticipantKind = "human" | "agent";
export type ParticipantRole = "host" | "guest";
export type AgentKind = "claude" | "gemini" | "codex";
/** What the sidebar renders. Client-set, server-echoed — never inferred. */
export type ParticipantState =
  | "coding"
  | "instructing"
  | "talking"
  | "watching"
  | "idle";
/** Does not change delivery — changes rendering and how loud the message
 *  reads in the sidebar activity line. */
export type MsgIntent = "instruct" | "ask" | "tell" | "handoff" | "chat";
export type ImpactSeverity = "direct" | "likely";
export type EntryRole = "user" | "assistant" | "tool" | "system";

/**
 * What a participant is allowed to do — `watch` reads, `drive` acts.
 *
 * The server is the enforcement point: it drops a `msg` from a `watch`
 * participant and answers `error`. Nothing in this module or the store is a
 * security boundary; the selectors exist so a composer can be switched off
 * before someone types into it, which is a courtesy, not a check.
 */
export type AccessLevel = "watch" | "drive";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["watch", "drive"];

export const PARTICIPANT_STATES: readonly ParticipantState[] = [
  "coding",
  "instructing",
  "talking",
  "watching",
  "idle",
];
export const MSG_INTENTS: readonly MsgIntent[] = [
  "instruct",
  "ask",
  "tell",
  "handoff",
  "chat",
];

export type Participant = {
  /** Stable for the life of the socket, e.g. `p_7f3a`. */
  id: string;
  user_id: string;
  name: string;
  avatar: string | null;
  kind: ParticipantKind;
  agent_kind: AgentKind | null;
  role: ParticipantRole;
  /** Set by the host, defaulting to whatever the session was shared with. The
   *  host is always `drive` and cannot be demoted. */
  access: AccessLevel;
  state: ParticipantState;
  since: number;
};

/** Who produced a transcript entry. In a shared session a `role: "user"`
 *  entry is no longer implicitly *you* — this is what makes it legible. */
export type EntryAuthor = {
  id: string;
  name: string;
  kind: ParticipantKind;
};

export type Entry = {
  id: string;
  /** Monotonic per session, assigned by the server. */
  seq: number;
  role: EntryRole;
  author: EntryAuthor;
  text: string;
  at: number;
};

/** A host publishing agent output has no `seq` yet — the server assigns it on
 *  the way through and echoes it back on the `transcript` frame. */
export type EntryDraft = Omit<Entry, "seq"> & { seq?: number };

export type SessionLiveRef = {
  symbol: string;
  file: string;
};

/** The `as` payload on `hello`. Rust builds this from the cloud account; the
 *  renderer never sends `hello` itself. */
export type SessionLiveIdentity = {
  name: string;
  avatar: string | null;
  kind: ParticipantKind;
  agent_kind?: AgentKind | null;
};

// ── Client → server frames ───────────────────────────────────────────────
//
// The renderer sends these through typed commands rather than as raw JSON,
// but the shapes are the contract half the doc names, so they are typed here
// and the command wrappers below are checked against them.

export type HelloFrame = {
  type: "hello";
  token: string;
  role: ParticipantRole;
  as: SessionLiveIdentity;
};

export type MsgClientFrame = {
  type: "msg";
  /** null = everyone. Broadcast is talking to the room, not commanding it. */
  to: string | null;
  text: string;
  intent: MsgIntent;
  refs: SessionLiveRef[];
  reply_to: string | null;
};

export type TranscriptClientFrame = {
  type: "transcript";
  entry: EntryDraft;
};

export type TypingClientFrame = { type: "typing"; on: boolean };

export type CursorClientFrame = { type: "cursor"; file: string; line: number };

export type ByeFrame = { type: "bye" };

export type SessionLiveClientFrame =
  | HelloFrame
  | MsgClientFrame
  | TranscriptClientFrame
  | TypingClientFrame
  | CursorClientFrame
  | ByeFrame;

// ── Server → client frames ───────────────────────────────────────────────

export type ReadyFrame = {
  type: "ready";
  session_id: string;
  /** Null until the server has minted our participant record. */
  you: Participant | null;
  host_online: boolean;
  /** EXTENSION: participant ids the server minted for the agents THIS desktop
   *  declared. A `msg` addressed at one of these is injected locally. */
  your_agents: string[];
  /** The role actually granted — a host that lost the race reads "guest". */
  role: ParticipantRole;
  /** The link to hand to the other person. */
  share_url: string | null;
};

export type PresenceFrame = {
  type: "presence";
  participants: Participant[];
};

export type TranscriptFrame = {
  type: "transcript";
  seq: number;
  entry: Entry;
};

/** The client `msg` with `from`, `seq` and `at` stamped by the server. */
export type MsgFrame = {
  type: "msg";
  seq: number;
  from: string;
  to: string | null;
  text: string;
  intent: MsgIntent;
  refs: SessionLiveRef[];
  reply_to: string | null;
  at: number;
  /** EXTENSION from the desktop: the sender's full record, resolved against
   *  presence at delivery time, so a row can name them even if they have
   *  since left. Null when the roster didn't know them. */
  from_participant: Participant | null;
  /** EXTENSION: true when this desktop injected the text into its own running
   *  agent — i.e. the message did not just render, it took effect here. */
  injected: boolean;
};

export type ImpactFrame = {
  type: "impact";
  from: string;
  symbol: string;
  file: string;
  severity: ImpactSeverity;
  at: number;
};

export type TypingFrame = { type: "typing"; from: string; on: boolean };

/** EXTENSION: the doc lists `cursor` client→server only, but the desktop
 *  forwards it so a guest can follow where someone is reading. */
export type CursorFrame = {
  type: "cursor";
  from: string;
  file: string;
  line: number;
};

export type HostFrame = { type: "host"; online: boolean };

export type ErrorFrame = { type: "error"; message: string; fatal: boolean };

/** A tunnel this session was reaching has gone. Without it a guest keeps
 *  showing a live-looking link to a port that closed minutes ago. */
export type TunnelClosedFrame = {
  type: "tunnel_closed";
  code: string;
  port: number;
};

export type SessionLiveServerFrame =
  | ReadyFrame
  | PresenceFrame
  | TranscriptFrame
  | MsgFrame
  | ImpactFrame
  | TypingFrame
  | CursorFrame
  | HostFrame
  | ErrorFrame
  | TunnelClosedFrame;

/** Tunnel proxy frames never reach the renderer — `tunnel.rs` answers them
 *  from Rust, because serving loopback bytes through the webview would be a
 *  second SSRF surface. Typed only so nobody re-adds them here by mistake. */
export type TunnelReqFrame = {
  type: "tunnel_req";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body_b64: string | null;
  port: number | null;
  code: string | null;
};

/** A tunnel this session opened. `opened_at` is stamped locally: the desktop's
 *  `TunnelInfo` has no such field and the row renders "open 4m". */
export type SessionTunnel = {
  code: string;
  url: string;
  port: number;
  label: string;
  opened_at: number;
  /** `aura://localhost:<port>` — the display form the composer accepts. */
  display?: string;
  session_id?: string;
};

/** The answer to `POST /api/v2/sessions/{id}/share` — what a person actually
 *  hands to a teammate, plus what that teammate arrives as. */
export type SessionShare = {
  /** Six characters, typed instead of opening the link. */
  code: string;
  link: string;
  default_access: AccessLevel;
};

/**
 * `GET /api/v2/sessions/join/{code}/preview` — what you see BEFORE the socket
 * opens.
 *
 * Joining is an informed act: whose machine you are about to act on, who is
 * already in there, and what you will be allowed to do. A code you are not
 * entitled to see 404s, so a wrong code and another org's code are
 * indistinguishable from here.
 */
export type SessionJoinPreview = {
  external_id: string;
  title: string;
  host: { name: string; machine: string };
  participants: Participant[];
  host_online: boolean;
  your_access: AccessLevel;
};

/** What every lifecycle command hands back (`SessionLiveInfo` in Rust). */
export type SessionLiveInfo = {
  session_id: string;
  role: ParticipantRole;
  requested_role: ParticipantRole;
  connected: boolean;
  share_url: string;
  /** The code behind that link, or null when the cloud has not minted one —
   *  the session is joinable by id from inside the app, but there is nothing
   *  to paste. Carried here so a desktop that comes up already hosting knows
   *  it is shared without a second round trip. */
  share_code: string | null;
  /** What an arriving teammate gets before the host changes it. */
  default_access: AccessLevel;
  participant_id: string | null;
  host_online: boolean;
  state: ParticipantState;
  participants: Participant[];
  /** The local agent session this share is wired to. Null means a message
   *  addressed at an agent has nowhere to land on this desktop. */
  agent_session_id: string | null;
  tunnels: SessionTunnel[];
};

/** Payload of `session-live:status` — the transport's own health, separate
 *  from any protocol frame. */
export type SessionLiveStatusEvent = {
  session_id: string;
  role: ParticipantRole;
  requested_role: ParticipantRole;
  connected: boolean;
  share_url: string | null;
  participant_id: string | null;
  host_online: boolean;
  state: ParticipantState;
  error: string | null;
};

export type SessionLiveConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "error";

/** Rust reconnects on its own with backoff, so "not connected" means "trying
 *  again", not "dead" — the only terminal states come from the renderer
 *  leaving or from a command that refused outright. */
export function connectionStatusFor(
  ev: SessionLiveStatusEvent,
): SessionLiveConnectionStatus {
  return ev.connected ? "live" : "reconnecting";
}

