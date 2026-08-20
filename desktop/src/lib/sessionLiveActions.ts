// Session Live plane — the things a person does: share, join, say, leave.
//
// Every action funnels through the registry, and every one of them tolerates
// being called on a session that has no socket: the answer is `false`/`null`
// and a sentence in `lastError`, never a throw into a click handler.
//
// Reconnect is deliberately absent. `conn.rs` owns dial, backoff and
// `?since=<seq>` replay, so the store's job after a drop is to reflect the
// status event — not to open a second socket racing the first.

import {
  SessionLiveClient,
  connectionStatusFor,
  fetchLiveSessions,
  fetchSessionTunnels,
  fetchShareStatus,
  revokeSessionShare,
  setParticipantAccess,
  type AccessLevel,
  type Entry,
  type ImpactSeverity,
  type ParticipantState,
  type SendMessageOptions,
  type SessionLiveInfo,
  type SessionShare,
  type SessionTunnel,
} from "./sessionLive";
import {
  EMPTY_TYPING,
  ENTRY_RETENTION,
  emptyState,
  mergeBySeq,
} from "./sessionLiveModel";
import {
  applyFrame,
  applyInfo,
  emit,
  ensureEntry,
  patch,
  sessions,
  shareOf,
} from "./sessionLiveRegistry";

// ── Lifecycle ────────────────────────────────────────────────────────────

async function connect(
  sessionId: string,
  role: "host" | "guest",
  target?: string,
  defaultAccess?: AccessLevel,
): Promise<SessionLiveInfo | null> {
  if (!sessionId) return null;
  const existing = sessions.get(sessionId);
  if (existing?.client) {
    if (existing.client.role === role) {
      // Already in it in this role. For a host that is not a no-op: the
      // desktop's share command is also the watch/drive toggle, so re-issuing
      // it is how a level change reaches the cloud. Re-issue it through the
      // client we already have rather than opening a second socket.
      const info = await existing.client.connect(target, defaultAccess);
      if (info) applyInfo(ensureEntry(sessionId), info);
      return info;
    }
    // The desktop refuses a role switch until we leave, so do that.
    await leaveSession(sessionId);
  }
  const entry = ensureEntry(sessionId);
  const client = new SessionLiveClient({
    sessionId,
    role,
    onFrame: (frame) => applyFrame(ensureEntry(sessionId), frame),
    onStatus: (ev) => {
      const e = ensureEntry(sessionId);
      patch(e, {
        connection: connectionStatusFor(ev),
        role: ev.role,
        hostOnline: ev.host_online,
        shareUrl: ev.share_url ?? e.state.shareUrl,
        lastError: ev.error ?? e.state.lastError,
      });
    },
    onError: (message) => patch(ensureEntry(sessionId), { lastError: message }),
  });
  entry.client = client;
  patch(entry, { connection: "connecting", lastError: null });
  const info = await client.connect(target, defaultAccess);
  if (!info) {
    // The command refused — `onError` already recorded why.
    patch(ensureEntry(sessionId), { connection: "error" });
    return null;
  }
  applyInfo(ensureEntry(sessionId), info);
  return info;
}

/**
 * Host this session — publish its agent transcript to whoever joins, and mint
 * the link that lets them.
 *
 * This is the one call the share surface makes, and it has to be one call:
 * minting over HTTP without opening the socket leaves a live link pointing at
 * a desktop that is not listening, and opening the socket without minting
 * leaves a host with nothing to hand anybody. `defaultAccess` is what an
 * arriving teammate gets; re-calling with a different level re-mints at that
 * level rather than handing out a second link.
 *
 * Returns null when the desktop refused; the reason lands in `lastError`.
 */
export function shareSession(
  sessionId: string,
  defaultAccess?: AccessLevel,
): Promise<SessionLiveInfo | null> {
  return connect(sessionId, "host", undefined, defaultAccess);
}

/** Join someone else's session as a guest. `target` may be a session id or a
 *  share link — the desktop parses both. */
export function joinSession(
  target: string,
  sessionId?: string,
): Promise<SessionLiveInfo | null> {
  const id = sessionId ?? sessionIdFromTarget(target);
  return connect(id, "guest", target);
}

/**
 * Remember the machine a session runs on.
 *
 * No live frame carries it — only the join preview does, and only when the
 * guest arrived by code. So whoever holds a preview hands it over here, and
 * every surface downstream reads one field instead of re-fetching or, worse,
 * printing the local device's name for a session on somebody else's desk. Left
 * null, the guest's banner says "their machine", which is vague and true.
 */
export function noteSessionHostMachine(
  sessionId: string,
  machine: string | null | undefined,
): void {
  const name = (machine ?? "").trim();
  if (!sessionId || !name) return;
  const entry = ensureEntry(sessionId);
  if (entry.state.hostMachine === name) return;
  patch(entry, { hostMachine: name });
}

/** Pull the session id out of a share link so the store can key state before
 *  the desktop answers. Mirrors `parse_target` in `cmd_session_live`. */
export function sessionIdFromTarget(target: string): string {
  const t = target.trim();
  if (!t) return "";
  const withoutScheme = t.replace(/^aura:\/\/session\//, "");
  if (!/^https?:\/\//.test(withoutScheme) && !withoutScheme.includes("/")) {
    return withoutScheme.split("?")[0] ?? "";
  }
  const path = withoutScheme.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** Close the socket. Cached transcript + roster survive so re-joining does
 *  not flash an empty panel; `resetSessionLive` is the hard clear. */
export async function leaveSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const client = entry.client;
  entry.client = null;
  for (const t of entry.typingTimers.values()) window.clearTimeout(t);
  entry.typingTimers.clear();
  patch(entry, {
    connection: "closed",
    typing: EMPTY_TYPING,
    hostOnline: false,
    // "Tunnels die with the socket that opened them" — and we can no longer
    // ask, so this is "unknown", not "none".
    tunnels: null,
  });
  if (client) await client.leave();
}

/** Drop every trace of a session — call when the user closes it for good. */
export function resetSessionLive(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  void leaveSession(sessionId);
  entry.state = emptyState(sessionId);
  emit(entry);
  sessions.delete(sessionId);
}

/** Hydrate from the sessions this desktop is already in — the app can come
 *  up with live shares from a previous view mount. */
export async function refreshLiveSessions(): Promise<SessionLiveInfo[]> {
  const list = await fetchLiveSessions();
  for (const info of list) applyInfo(ensureEntry(info.session_id), info);
  return list;
}

// ── Sends ────────────────────────────────────────────────────────────────

function clientFor(sessionId: string): SessionLiveClient | null {
  return sessions.get(sessionId)?.client ?? null;
}

/**
 * The addressable message — every pairing goes through here. `to` is a
 * participant id (a human, my agent, or a peer's agent) or null for the room.
 * False means it didn't go out; the reason is in `lastError`.
 */
export function sendSessionMessage(
  sessionId: string,
  opts: SendMessageOptions,
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return Promise.resolve(false);
  return client.sendMessage(opts);
}

export function setSessionTyping(
  sessionId: string,
  on: boolean,
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return Promise.resolve(false);
  return client.setTyping(on);
}

export function sendSessionCursor(
  sessionId: string,
  file: string,
  line: number,
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return Promise.resolve(false);
  return client.sendCursor(file, line);
}

/** Set what the sidebar renders next to our avatar in this session. */
export function setSessionPresenceState(
  sessionId: string,
  state: ParticipantState,
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return Promise.resolve(false);
  return client.setPresenceState(state);
}

/** Raise a collision into the session the moment it is noticed. */
export function raiseSessionImpact(
  sessionId: string,
  opts: { symbol: string; file: string; severity?: ImpactSeverity },
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return Promise.resolve(false);
  return client.raiseImpact(opts);
}

/** Fold history (from `/sessions/{id}/messages`) into the same deduped,
 *  seq-ordered list the live frames land in, so a panel opens full. */
export function seedSessionEntries(sessionId: string, list: Entry[]): void {
  if (!sessionId || list.length === 0) return;
  const entry = ensureEntry(sessionId);
  let entries = entry.state.entries;
  let lastSeq = entry.state.lastSeq;
  for (const e of list) {
    entries = mergeBySeq(entries, e, (a, b) => a.id === b.id, ENTRY_RETENTION);
    if (e.seq > lastSeq) lastSeq = e.seq;
  }
  if (entries === entry.state.entries && lastSeq === entry.state.lastSeq) return;
  patch(entry, { entries, lastSeq });
}

// ── Sharing and access ───────────────────────────────────────────────────

function noteError(sessionId: string): (message: string) => void {
  return (message) => patch(ensureEntry(sessionId), { lastError: message });
}

/**
 * Mint the code + link for this session, and start hosting it.
 *
 * Those are one act, not two. The desktop's share command opens the socket and
 * mints in the same breath, so a version of this that only spoke HTTP would
 * hand out a link to a desktop that never attached its listeners: the host
 * would watch an empty room while the guest sat in a live one.
 */
export async function createShare(
  sessionId: string,
  defaultAccess: AccessLevel = "watch",
): Promise<SessionShare | null> {
  const info = await shareSession(sessionId, defaultAccess);
  if (!info) return null;
  const share = shareOf(info);
  if (share) patch(ensureEntry(sessionId), { share, lastError: null });
  return share;
}

/**
 * Ask whether this session is already shared, without sharing it.
 *
 * The share surface calls this on open. `true` means the answer landed (and
 * `share` in the store is now right, including when the right answer is
 * "none"); `false` means we could not ask, and the caller must not read the
 * absence of a share as privacy.
 */
export async function readShareStatus(sessionId: string): Promise<boolean> {
  const status = await fetchShareStatus(sessionId, noteError(sessionId));
  if (!status) return false;
  patch(ensureEntry(sessionId), {
    share: status.shared ? status.share : null,
    lastError: null,
  });
  return true;
}

/** Stop sharing. The link and code stop resolving. */
export async function revokeShare(sessionId: string): Promise<boolean> {
  const ok = await revokeSessionShare(sessionId, noteError(sessionId));
  if (ok) patch(ensureEntry(sessionId), { share: null });
  return ok;
}

/**
 * Host-only: change what one participant may do.
 *
 * The optimistic patch is a courtesy so the row doesn't sit still for a round
 * trip; the server's next `presence` overwrites it either way, which is what
 * makes it safe to be optimistic here and nowhere near the check that decides
 * whether a message is actually delivered.
 */
export async function changeParticipantAccess(
  sessionId: string,
  participantId: string,
  access: AccessLevel,
): Promise<boolean> {
  const ok = await setParticipantAccess(
    sessionId,
    participantId,
    access,
    noteError(sessionId),
  );
  if (!ok) return false;
  const entry = ensureEntry(sessionId);
  const participants = entry.state.participants.map((p) =>
    p.id === participantId ? { ...p, access } : p,
  );
  const you =
    entry.state.you && entry.state.you.id === participantId
      ? { ...entry.state.you, access }
      : entry.state.you;
  patch(entry, { participants, you });
  return true;
}

// ── Tunnels ──────────────────────────────────────────────────────────────

/** Share a local port with the room. Null when the open was refused. */
export async function openSessionTunnel(
  sessionId: string,
  port: number,
  label?: string,
): Promise<SessionTunnel | null> {
  const client = clientFor(sessionId);
  if (!client) return null;
  const tunnel = await client.openTunnel(port, label);
  if (!tunnel) return null;
  const entry = ensureEntry(sessionId);
  const rest = (entry.state.tunnels ?? []).filter((t) => t.code !== tunnel.code);
  patch(entry, { tunnels: [...rest, tunnel] });
  return tunnel;
}

export async function closeSessionTunnel(
  sessionId: string,
  code: string,
): Promise<boolean> {
  const client = clientFor(sessionId);
  if (!client) return false;
  const ok = await client.closeTunnel(code);
  if (!ok) return false;
  const entry = ensureEntry(sessionId);
  const current = entry.state.tunnels;
  if (current) patch(entry, { tunnels: current.filter((t) => t.code !== code) });
  return true;
}

/** Re-read the desktop's tunnel list — the authority, since a tunnel can die
 *  with its socket without anyone telling the renderer. Leaves `tunnels` as it
 *  was when the desktop could not be asked, so a failed refresh never reads as
 *  "nothing is open". */
export async function refreshSessionTunnels(
  sessionId: string,
): Promise<SessionTunnel[] | null> {
  const tunnels = await fetchSessionTunnels(sessionId, noteError(sessionId));
  if (tunnels) patch(ensureEntry(sessionId), { tunnels });
  return tunnels;
}

