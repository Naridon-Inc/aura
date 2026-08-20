// Session Live plane — the Tauri command surface.
//
// The socket itself lives in Rust (`src-tauri/src/cmd_session_live`) because
// it holds the cloud bearer and does the org/repo membership handshake, so the
// renderer never opens one: it drives the desktop over these commands and
// receives frames as Tauri events. That is also why this module invokes
// `@tauri-apps/api/core` directly instead of going through `./api` — same
// reason `roomAuth.ts` does, keeping the transport free of an api.ts cycle.
//
// Nothing here throws at the caller. A refused command answers `null` (or
// `false`, or `[]`) and hands a readable sentence to the caller's error sink;
// a dead cloud must surface as a message, not as a crashed panel.

import { invoke } from "@tauri-apps/api/core";

import {
  isObj,
  parseJoinPreview,
  parseSessionLiveInfo,
  parseSessionShare,
  parseTunnel,
} from "./sessionLiveParse";
import type {
  AccessLevel,
  SessionJoinPreview,
  SessionLiveInfo,
  SessionShare,
  SessionTunnel,
} from "./sessionLiveFrames";

// ── Command names ────────────────────────────────────────────────────────
//
// Confirmed against `cmd_session_live/mod.rs` (the `#[tauri::command]` fns).
// Both sides name the same strings in one place, so a rename is a one-line
// edit here and there.

export const SESSION_LIVE_COMMANDS = {
  share: "session_live_share",
  join: "session_live_join",
  send: "session_live_send",
  impact: "session_live_impact",
  setState: "session_live_set_state",
  typing: "session_live_typing",
  cursor: "session_live_cursor",
  leave: "session_live_leave",
  status: "session_live_status",
  tunnelOpen: "session_live_tunnel_open",
  tunnelClose: "session_live_tunnel_close",
  tunnels: "session_live_tunnels",
  // The HTTP surface around the socket (`POST/DELETE /sessions/{id}/share`,
  // `GET /sessions/join/{code}/preview`, `PATCH …/participants/{pid}/access`).
  // It goes through the desktop like everything else rather than `fetch`,
  // because the cloud JWT lives in the Rust keychain and the webview has no
  // business holding it.
  shareCreate: "session_live_share_create",
  shareRevoke: "session_live_share_revoke",
  shareStatus: "session_live_share_status",
  joinPreview: "session_live_join_preview",
  setAccess: "session_live_set_access",
} as const;
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Session live transport failed";
}

/** Tauri v2 maps camelCase invoke keys onto snake_case Rust params, but a
 *  command declared `rename_all = "snake_case"` wants the raw name. Sending
 *  both spellings costs nothing — the arg resolver looks each parameter up by
 *  name and ignores the rest — and removes a whole class of silent-null bug. */
export function bothCases(pairs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pairs)) {
    out[k] = v;
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (snake !== k) out[snake] = v;
  }
  return out;
}

/** Every session this desktop is currently hosting or watching. Empty when
 *  the command is unavailable (older build) — never throws. */
export async function fetchLiveSessions(): Promise<SessionLiveInfo[]> {
  try {
    const res = await invoke<unknown>(SESSION_LIVE_COMMANDS.status);
    if (!Array.isArray(res)) return [];
    const out: SessionLiveInfo[] = [];
    for (const row of res) {
      const parsed = parseSessionLiveInfo(row);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}
// ── Sharing (the HTTP surface around the socket) ─────────────────────────
//
// These are deliberately free functions rather than methods on the client:
// creating a link, previewing a code and reading the tunnel list all happen
// when there is no socket — before you share, before you join, and after a
// host went away. Requiring a live client for them would mean opening one to
// answer "what would happen if I joined", which is exactly what the preview
// exists to avoid.
//
// Each reports failure the same way the client does: `null` (or `[]`), with a
// readable sentence handed to `onError`. Nothing here throws into a view.

/** Failure reporter shared by the free functions. */
export type SessionLiveErrorSink = (message: string) => void;

function reportFailure(sink: SessionLiveErrorSink | undefined, e: unknown): void {
  if (!sink) return;
  try {
    sink(errText(e));
  } catch (inner) {
    console.warn("sessionLive error sink threw", inner);
  }
}

/** Open this session up to teammates. `defaultAccess` is what an arriving
 *  teammate gets before the host changes it. */
export async function createSessionShare(
  sessionId: string,
  defaultAccess: AccessLevel = "watch",
  onError?: SessionLiveErrorSink,
): Promise<SessionShare | null> {
  try {
    const res = await invoke<unknown>(
      SESSION_LIVE_COMMANDS.shareCreate,
      bothCases({ sessionId, defaultAccess }),
    );
    return parseSessionShare(res);
  } catch (e) {
    reportFailure(onError, e);
    return null;
  }
}

/**
 * Whether this session is already shared — a pure read that never mints a
 * link.
 *
 * Three outcomes, all different, none of which may be collapsed: `null` is "we
 * could not ask", `{ shared: false }` is "we asked and it is private", and
 * `{ shared: true }` carries the live link. A surface that showed the first as
 * the second would offer to share a session that already is, and a host would
 * hand out a second link for a room they thought was closed.
 */
export type SessionShareStatus =
  | { shared: false }
  | { shared: true; share: SessionShare };

export async function fetchShareStatus(
  sessionId: string,
  onError?: SessionLiveErrorSink,
): Promise<SessionShareStatus | null> {
  try {
    const res = await invoke<unknown>(
      SESSION_LIVE_COMMANDS.shareStatus,
      bothCases({ sessionId }),
    );
    if (res === null || res === undefined) return { shared: false };
    const share = parseSessionShare(res);
    return share ? { shared: true, share } : { shared: false };
  } catch (e) {
    reportFailure(onError, e);
    return null;
  }
}

/** Stop sharing. The link and code stop resolving; people already in are
 *  dropped by the server, not by us. */
export async function revokeSessionShare(
  sessionId: string,
  onError?: SessionLiveErrorSink,
): Promise<boolean> {
  try {
    await invoke(SESSION_LIVE_COMMANDS.shareRevoke, bothCases({ sessionId }));
    return true;
  } catch (e) {
    reportFailure(onError, e);
    return false;
  }
}

/** What you are about to walk into, for a share code. Null when the code is
 *  unknown OR belongs to a team you are not in — the server makes those two
 *  indistinguishable on purpose. */
export async function fetchJoinPreview(
  code: string,
  onError?: SessionLiveErrorSink,
): Promise<SessionJoinPreview | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  try {
    const res = await invoke<unknown>(
      SESSION_LIVE_COMMANDS.joinPreview,
      bothCases({ code: trimmed }),
    );
    return parseJoinPreview(res);
  } catch (e) {
    reportFailure(onError, e);
    return null;
  }
}

/** Host-only: change what one participant may do. Takes effect on their live
 *  socket immediately and comes back in the next `presence`. */
export async function setParticipantAccess(
  sessionId: string,
  participantId: string,
  access: AccessLevel,
  onError?: SessionLiveErrorSink,
): Promise<boolean> {
  try {
    await invoke(
      SESSION_LIVE_COMMANDS.setAccess,
      bothCases({ sessionId, participantId, access }),
    );
    return true;
  } catch (e) {
    reportFailure(onError, e);
    return false;
  }
}

/** The session's tunnels without holding a client — the share surface asks
 *  this before anyone has joined. */
export async function fetchSessionTunnels(
  sessionId: string,
  onError?: SessionLiveErrorSink,
): Promise<SessionTunnel[] | null> {
  try {
    const res = await invoke<unknown>(
      SESSION_LIVE_COMMANDS.tunnels,
      bothCases({ sessionId }),
    );
    const rows = Array.isArray(res)
      ? res
      : isObj(res) && Array.isArray(res.tunnels)
        ? res.tunnels
        : null;
    // Null, not `[]`: "we could not ask" and "nothing is open" are different
    // sentences, and the share panel says the wrong one if they collapse.
    if (!rows) return null;
    const now = Math.floor(Date.now() / 1000);
    const out: SessionTunnel[] = [];
    for (const t of rows) {
      const parsed = parseTunnel(t, now);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch (e) {
    reportFailure(onError, e);
    return null;
  }
}

