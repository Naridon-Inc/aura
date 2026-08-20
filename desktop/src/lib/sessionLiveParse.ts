// Session Live plane — turning whatever arrived into something typed.
//
// Every function here answers with a value or with `null`. None of them
// throws, and that is the whole point: the protocol requires an unknown frame
// type to be IGNORED rather than to close the socket, and a field the cloud
// added after us must not cost the frame it rode in on. A parser that threw
// would turn either of those into a blank panel.
//
// The same discipline applies to enum values: an unrecognised `state`,
// `intent` or `severity` degrades to the quietest sensible member instead of
// dropping the record, because a participant with a state we don't know about
// is still a person in the room.

import {
  ACCESS_LEVELS,
  MSG_INTENTS,
  PARTICIPANT_STATES,
  type AccessLevel,
  type AgentKind,
  type Entry,
  type Participant,
  type SessionJoinPreview,
  type SessionLiveInfo,
  type SessionLiveRef,
  type SessionLiveServerFrame,
  type SessionLiveStatusEvent,
  type SessionShare,
  type SessionTunnel,
} from "./sessionLiveFrames";

// ── Defensive parsing ────────────────────────────────────────────────────

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

const KINDS = ["human", "agent"] as const;
const ROLES = ["host", "guest"] as const;
const AGENT_KINDS = ["claude", "gemini", "codex"] as const;
const ENTRY_ROLES = ["user", "assistant", "tool", "system"] as const;
const SEVERITIES = ["direct", "likely"] as const;

export function parseParticipant(raw: unknown): Participant | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null; // an id-less participant can't key a roster row
  const role = oneOf(raw.role, ROLES, "guest");
  // A server that doesn't speak `access` yet accepts `msg` from any guest, so
  // reading the absent field as `watch` would grey out composers that in fact
  // work. Absence means "no such rule here"; only an explicit `watch` locks a
  // composer, and the server refuses regardless of what we render.
  const access: AccessLevel =
    role === "host" ? "drive" : oneOf(raw.access, ACCESS_LEVELS, "drive");
  return {
    id,
    user_id: str(raw.user_id),
    name: str(raw.name) || id,
    avatar: nullableStr(raw.avatar),
    kind: oneOf(raw.kind, KINDS, "human"),
    agent_kind:
      typeof raw.agent_kind === "string" &&
      (AGENT_KINDS as readonly string[]).includes(raw.agent_kind)
        ? (raw.agent_kind as AgentKind)
        : null,
    role,
    access,
    state: oneOf(raw.state, PARTICIPANT_STATES, "watching"),
    since: num(raw.since),
  };
}

function parseParticipants(raw: unknown): Participant[] {
  if (!Array.isArray(raw)) return [];
  const out: Participant[] = [];
  for (const p of raw) {
    const parsed = parseParticipant(p);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseEntry(raw: unknown, seqHint = 0): Entry | null {
  if (!isObj(raw)) return null;
  const author = isObj(raw.author) ? raw.author : {};
  const seq = num(raw.seq, seqHint);
  const id = str(raw.id) || (seq > 0 ? `e_seq_${seq}` : "");
  if (!id) return null; // no id and no seq — nothing stable to key or dedupe on
  return {
    id,
    seq,
    role: oneOf(raw.role, ENTRY_ROLES, "assistant"),
    author: {
      id: str(author.id),
      name: str(author.name),
      kind: oneOf(author.kind, KINDS, "human"),
    },
    text: str(raw.text),
    at: num(raw.at),
  };
}

function parseRefs(raw: unknown): SessionLiveRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionLiveRef[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    out.push({ symbol: str(r.symbol), file: str(r.file) });
  }
  return out;
}

/** Normalise a desktop `TunnelInfo` into the shape the surfaces render.
 *  `opened_at` is stamped now when the transport didn't carry one. */
export function parseTunnel(raw: unknown, nowSecs: number): SessionTunnel | null {
  if (!isObj(raw)) return null;
  const code = str(raw.code);
  if (!code) return null;
  const port = num(raw.port);
  return {
    code,
    url: str(raw.url),
    port,
    label: str(raw.label) || `localhost:${port}`,
    opened_at: num(raw.opened_at, nowSecs),
    display: str(raw.display) || `aura://localhost:${port}`,
    session_id: str(raw.session_id) || undefined,
  };
}

export function parseSessionLiveInfo(raw: unknown): SessionLiveInfo | null {
  if (!isObj(raw)) return null;
  const sessionId = str(raw.session_id);
  if (!sessionId) return null;
  const now = Math.floor(Date.now() / 1000);
  const tunnels: SessionTunnel[] = [];
  if (Array.isArray(raw.tunnels)) {
    for (const t of raw.tunnels) {
      const parsed = parseTunnel(t, now);
      if (parsed) tunnels.push(parsed);
    }
  }
  return {
    session_id: sessionId,
    role: oneOf(raw.role, ROLES, "guest"),
    requested_role: oneOf(raw.requested_role, ROLES, "guest"),
    connected: bool(raw.connected),
    share_url: str(raw.share_url),
    share_code: nullableStr(raw.share_code),
    default_access: oneOf(raw.default_access, ACCESS_LEVELS, "watch"),
    participant_id: nullableStr(raw.participant_id),
    host_online: bool(raw.host_online),
    state: oneOf(raw.state, PARTICIPANT_STATES, "watching"),
    participants: parseParticipants(raw.participants),
    agent_session_id: nullableStr(raw.agent_session_id),
    tunnels,
  };
}

export function parseSessionShare(raw: unknown): SessionShare | null {
  if (!isObj(raw)) return null;
  const code = str(raw.code);
  const link = str(raw.link);
  // A share with neither is not a share — surfacing an empty "copy this" field
  // is worse than telling the person it failed.
  if (!code && !link) return null;
  return {
    code,
    link,
    default_access: oneOf(raw.default_access, ACCESS_LEVELS, "watch"),
  };
}

export function parseJoinPreview(raw: unknown): SessionJoinPreview | null {
  if (!isObj(raw)) return null;
  const externalId = str(raw.external_id);
  if (!externalId) return null; // nothing to join
  const host = isObj(raw.host) ? raw.host : {};
  return {
    external_id: externalId,
    title: str(raw.title) || "Untitled session",
    host: {
      name: str(host.name) || "Someone",
      machine: str(host.machine) || "their machine",
    },
    participants: parseParticipants(raw.participants),
    host_online: bool(raw.host_online),
    // Defaults to the safer level: promising `drive` and then having the
    // server refuse the first message is a worse first minute than the
    // reverse.
    your_access: oneOf(raw.your_access, ACCESS_LEVELS, "watch"),
  };
}

export function parseStatusEvent(raw: unknown): SessionLiveStatusEvent | null {
  if (!isObj(raw)) return null;
  const sessionId = str(raw.session_id);
  if (!sessionId) return null;
  return {
    session_id: sessionId,
    role: oneOf(raw.role, ROLES, "guest"),
    requested_role: oneOf(raw.requested_role, ROLES, "guest"),
    connected: bool(raw.connected),
    share_url: nullableStr(raw.share_url),
    participant_id: nullableStr(raw.participant_id),
    host_online: bool(raw.host_online),
    state: oneOf(raw.state, PARTICIPANT_STATES, "watching"),
    error: nullableStr(raw.error),
  };
}

/**
 * Turn a `type`-tagged JSON object into a typed server frame, or `null` for
 * anything unrecognised. Accepts a JSON string too. Never throws — an unknown
 * `type` is a no-op, which is the protocol's forward-compatibility rule.
 */
export function parseServerFrame(raw: unknown): SessionLiveServerFrame | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObj(value)) return null;
  switch (value.type) {
    case "ready":
      return {
        type: "ready",
        session_id: str(value.session_id),
        you: parseParticipant(value.you),
        host_online: bool(value.host_online, true),
        your_agents: Array.isArray(value.your_agents)
          ? value.your_agents.filter((v): v is string => typeof v === "string")
          : [],
        role: oneOf(value.role, ROLES, "guest"),
        share_url: nullableStr(value.share_url),
      };
    case "presence":
      return { type: "presence", participants: parseParticipants(value.participants) };
    case "transcript": {
      const seq = num(value.seq);
      const entry = parseEntry(value.entry, seq);
      if (!entry) return null;
      return { type: "transcript", seq: seq || entry.seq, entry };
    }
    case "msg":
      return {
        type: "msg",
        seq: num(value.seq),
        from: str(value.from),
        to: nullableStr(value.to),
        text: str(value.text),
        intent: oneOf(value.intent, MSG_INTENTS, "chat"),
        refs: parseRefs(value.refs),
        reply_to: nullableStr(value.reply_to),
        at: num(value.at),
        from_participant: parseParticipant(value.from_participant),
        injected: bool(value.injected),
      };
    case "impact":
      return {
        type: "impact",
        from: str(value.from),
        symbol: str(value.symbol),
        file: str(value.file),
        severity: oneOf(value.severity, SEVERITIES, "likely"),
        at: num(value.at),
      };
    case "typing":
      return { type: "typing", from: str(value.from), on: bool(value.on) };
    case "cursor":
      return {
        type: "cursor",
        from: str(value.from),
        file: str(value.file),
        line: num(value.line),
      };
    case "host":
      return { type: "host", online: bool(value.online) };
    case "error":
      return {
        type: "error",
        message: str(value.message, "Session live error"),
        fatal: bool(value.fatal),
      };
    case "tunnel_closed": {
      const code = str(value.code);
      if (!code) return null; // nothing to drop without one
      return { type: "tunnel_closed", code, port: num(value.port) };
    }
    default:
      return null; // unknown type — ignored, never fatal
  }
}
