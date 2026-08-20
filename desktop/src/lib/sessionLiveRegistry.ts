// Session Live plane — the live registry: one entry per shared session, and
// the reducer that folds wire frames into it.
//
// Same singleton-plus-subscriber-set shape as callStore / agentStreamStore /
// radarPresenceStore: a module-level Map keyed by the session's external id,
// and snapshot objects that are REPLACED rather than mutated so reference
// equality can skip re-renders.
//
// Subscribing is deliberately passive. Unlike radarPresenceStore, mounting a
// view must NOT open a socket — joining someone's session is a decision, not a
// side effect of rendering — so nothing in this file connects anything.

import {
  ENTRY_RETENTION,
  MESSAGE_RETENTION,
  TYPING_TTL_MS,
  emptyState,
  mergeBySeq,
  pushActivity,
  refOf,
  type SessionLiveState,
} from "./sessionLiveModel";
import type {
  SessionLiveClient,
  SessionLiveInfo,
  SessionLiveServerFrame,
  SessionShare,
} from "./sessionLive";

export type SessionEntry = {
  state: SessionLiveState;
  subs: Set<() => void>;
  client: SessionLiveClient | null;
  /** Per-participant typing expiry timers. */
  typingTimers: Map<string, number>;
};

/** Every session this renderer holds state for, keyed by external id. */
export const sessions = new Map<string, SessionEntry>();

// ── Map-wide change signal ───────────────────────────────────────────────
//
// Per-session subscribers cover a view that is already looking at one session.
// The rail is looking at all of them AND at the set itself: a session it has
// never heard of appearing is the change it most needs to draw. So the registry
// also carries one counter, bumped whenever the map gains a key or any entry
// emits, which `useSyncExternalStore` can watch as a snapshot.

let registryVersion = 0;
const registrySubs = new Set<() => void>();

function bumpRegistry(): void {
  registryVersion += 1;
  for (const fn of registrySubs) fn();
}

/** Monotonic; changes whenever any session's state or the set of sessions
 *  does. Meaningless as a value — only its inequality matters. */
export function sessionsVersion(): number {
  return registryVersion;
}

/** Watch the whole registry rather than one session. */
export function subscribeSessions(cb: () => void): () => void {
  registrySubs.add(cb);
  return () => {
    registrySubs.delete(cb);
  };
}

export function ensureEntry(sessionId: string): SessionEntry {
  let e = sessions.get(sessionId);
  if (e) return e;
  e = {
    state: emptyState(sessionId),
    subs: new Set(),
    client: null,
    typingTimers: new Map(),
  };
  sessions.set(sessionId, e);
  bumpRegistry();
  return e;
}

export function emit(entry: SessionEntry): void {
  for (const fn of entry.subs) fn();
  bumpRegistry();
}

export function patch(entry: SessionEntry, next: Partial<SessionLiveState>): void {
  entry.state = { ...entry.state, ...next };
  emit(entry);
}

// ── Typing ───────────────────────────────────────────────────────────────

export function clearTypingTimer(entry: SessionEntry, participantId: string): void {
  const t = entry.typingTimers.get(participantId);
  if (t == null) return;
  window.clearTimeout(t);
  entry.typingTimers.delete(participantId);
}

export function setTypingFlag(
  entry: SessionEntry,
  participantId: string,
  on: boolean,
): void {
  if (!participantId) return;
  const has = entry.state.typing.has(participantId);
  clearTypingTimer(entry, participantId);
  if (on) {
    // Re-arm the expiry even when the flag was already set — a fresh
    // `typing:true` is the peer telling us they are still at the keyboard.
    entry.typingTimers.set(
      participantId,
      window.setTimeout(() => {
        entry.typingTimers.delete(participantId);
        setTypingFlag(entry, participantId, false);
      }, TYPING_TTL_MS),
    );
    if (has) return;
  } else if (!has) {
    return;
  }
  const typing = new Set(entry.state.typing);
  if (on) typing.add(participantId);
  else typing.delete(participantId);
  patch(entry, { typing });
}

// ── Frame reduction ──────────────────────────────────────────────────────

export function applyFrame(entry: SessionEntry, frame: SessionLiveServerFrame): void {
  switch (frame.type) {
    case "ready": {
      // Seed the roster with ourselves so a session nobody else has joined
      // still renders one avatar instead of an empty rail.
      const participants =
        frame.you && !entry.state.participants.some((p) => p.id === frame.you?.id)
          ? [...entry.state.participants, frame.you]
          : entry.state.participants;
      patch(entry, {
        connection: "live",
        role: frame.role,
        you: frame.you ?? entry.state.you,
        yourAgents: frame.your_agents,
        hostOnline: frame.host_online,
        shareUrl: frame.share_url ?? entry.state.shareUrl,
        participants,
      });
      break;
    }
    case "presence": {
      // The server's list is authoritative; keep our own record in sync with
      // whatever role/access/state it echoed back. A guest promoted to `drive`
      // learns about it here and nowhere else.
      const youId = entry.state.you?.id;
      const you = youId
        ? (frame.participants.find((p) => p.id === youId) ?? entry.state.you)
        : entry.state.you;
      patch(entry, { participants: frame.participants, you });
      break;
    }
    case "transcript": {
      const entries = mergeBySeq(
        entry.state.entries,
        frame.entry,
        (a, b) => a.id === b.id,
        ENTRY_RETENTION,
      );
      const lastSeq = Math.max(entry.state.lastSeq, frame.seq);
      if (entries === entry.state.entries && lastSeq === entry.state.lastSeq) break;
      patch(entry, { entries, lastSeq });
      break;
    }
    case "msg": {
      const messages = mergeBySeq(
        entry.state.messages,
        frame,
        (a, b) => a.seq === b.seq && a.from === b.from && a.at === b.at,
        MESSAGE_RETENTION,
      );
      const lastSeq = Math.max(entry.state.lastSeq, frame.seq);
      if (messages === entry.state.messages && lastSeq === entry.state.lastSeq) break;
      const activity = pushActivity(entry.state.activity, {
        id: frame.seq > 0 ? `m:${frame.seq}` : `m:${frame.from}:${frame.at}`,
        kind: "message",
        fromId: frame.from,
        toId: frame.to,
        intent: frame.intent,
        ref: refOf(frame.refs),
        text: frame.text,
        severity: null,
        at: frame.at,
      });
      // Saying something means you stopped typing, whatever you last claimed.
      clearTypingTimer(entry, frame.from);
      const typing = entry.state.typing.has(frame.from)
        ? new Set(entry.state.typing)
        : null;
      typing?.delete(frame.from);
      patch(entry, { messages, activity, lastSeq, ...(typing ? { typing } : {}) });
      break;
    }
    case "impact": {
      const activity = pushActivity(entry.state.activity, {
        id: `i:${frame.from}:${frame.at}:${frame.symbol}`,
        kind: "impact",
        fromId: frame.from,
        toId: null,
        intent: "tell",
        ref: frame.symbol || frame.file || null,
        text: "",
        severity: frame.severity,
        at: frame.at,
      });
      if (activity === entry.state.activity) break;
      patch(entry, { activity });
      break;
    }
    case "typing":
      setTypingFlag(entry, frame.from, frame.on);
      break;
    case "host":
      if (entry.state.hostOnline === frame.online) break;
      patch(entry, { hostOnline: frame.online });
      break;
    case "tunnel_closed": {
      // A guest otherwise keeps showing a live-looking link to a port that
      // closed minutes ago.
      const current = entry.state.tunnels;
      if (!current) break;
      const next = current.filter((t) => t.code !== frame.code);
      if (next.length === current.length) break;
      patch(entry, { tunnels: next });
      break;
    }
    case "error":
      patch(entry, {
        lastError: frame.message,
        connection: frame.fatal ? "error" : entry.state.connection,
      });
      break;
    case "cursor":
      // Follow-the-reader is a view concern with no state worth holding here
      // yet; named so it reads as a decision rather than a missed case.
      break;
  }
}

/**
 * The share carried by a lifecycle answer, or null when there is nothing to
 * hand anybody.
 *
 * A code with no link cannot happen and a link with no code can: the cloud
 * mints both together, but a desktop that got its socket up without the mint
 * still answers with an in-app `aura://session/…` deep link, which a teammate
 * inside the app can genuinely open. Refusing to call that a share would tell
 * a host their live session is private.
 */
export function shareOf(info: SessionLiveInfo): SessionShare | null {
  const code = info.share_code ?? "";
  if (!code && !info.share_url) return null;
  return { code, link: info.share_url, default_access: info.default_access };
}

/** Fold a lifecycle command's answer into the snapshot. */
export function applyInfo(entry: SessionEntry, info: SessionLiveInfo): void {
  patch(entry, {
    connection: info.connected ? "live" : "reconnecting",
    role: info.role,
    participants:
      info.participants.length > 0 ? info.participants : entry.state.participants,
    hostOnline: info.host_online,
    shareUrl: info.share_url || entry.state.shareUrl,
    // A desktop that comes up already hosting is already shared, and the code
    // is right there in `info`. Without this, a re-opened share panel reads
    // "not shared" for a session with a live link out in the world — and the
    // only way to correct it would be to mint a second one.
    share: shareOf(info) ?? entry.state.share,
    agentSessionId: info.agent_session_id,
    tunnels: info.tunnels,
    you:
      entry.state.you ??
      (info.participant_id
        ? (info.participants.find((p) => p.id === info.participant_id) ?? null)
        : null),
  });
}

// ── Selectors ────────────────────────────────────────────────────────────

/** Snapshot without subscribing. Always a real object, never undefined. */
export function getSessionLive(sessionId: string): SessionLiveState {
  return sessions.get(sessionId)?.state ?? emptyState(sessionId);
}

/** Every session we currently hold state for — the rail iterates this. */
export function liveSessionIds(): string[] {
  return [...sessions.keys()];
}

/**
 * Has this app got a socket for this session — is there a room to walk into?
 *
 * Distinct from "does a session with this id exist", which is a question about
 * the plane and not about us. A row in the people rail can come from a roster
 * read, where all we know is that somebody, somewhere, has a session; opening
 * a live pane for one of those would show a room that never fills, because
 * nothing ever joined it.
 *
 * `closed` and `error` count as connected: the socket was real and its history
 * is on screen, and a pane that vanished the moment the network hiccuped would
 * take the transcript with it. Only `idle` — the state `getSessionLive`
 * invents for an id it has never seen — means there is nothing here.
 */
export function isSessionLive(sessionId: string): boolean {
  return (sessions.get(sessionId)?.state.connection ?? "idle") !== "idle";
}

/** The external session an agent running on THIS machine is shared as, or null
 *  if nobody has shared it.
 *
 *  The two ids are different things and neither can be derived from the other:
 *  a PTY handle is local and per-process, an external id is minted by the cloud
 *  when the session is shared. The link exists only in `ready` / `info`, which
 *  is why this is a scan of what the registry was told rather than a lookup. */
export function sessionIdForAgent(agentSessionId: string): string | null {
  if (!agentSessionId) return null;
  for (const [id, entry] of sessions) {
    if (entry.state.agentSessionId === agentSessionId) return id;
  }
  return null;
}


export function subscribe(sessionId: string, cb: () => void): () => void {
  const entry = ensureEntry(sessionId);
  entry.subs.add(cb);
  return () => {
    entry.subs.delete(cb);
  };
}
