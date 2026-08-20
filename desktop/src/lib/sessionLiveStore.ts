// Session Live plane — the React seam, and the one import path for the plane's
// state.
//
// Hooks only: every hook is a `useSyncExternalStore` over the registry, and
// each derivation is memoised on the snapshot object, which is replaced (never
// mutated) on change — so a session that is quiet re-renders nothing.
//
// This module re-exports the model, the selectors, the registry readers and
// the actions so consumers keep a single `./sessionLiveStore` import. The
// split behind it is about file size and testability, not about making callers
// learn four module names.
//
// Two lists, not one. `entries` is the agent transcript (server-assigned seq);
// `messages` is what people and agents said to each other. They interleave by
// seq at render time (`sessionStream`) rather than being merged at ingest,
// because only the transcript is replayed by the durability path and merging
// them in the store would make a re-join duplicate every message.

import { useMemo, useSyncExternalStore } from "react";

import type {
  AccessLevel,
  Participant,
  SessionShare,
  SessionTunnel,
  SessionLiveConnectionStatus,
} from "./sessionLive";
import type {
  SessionActivity,
  SessionLiveState,
  SessionStreamItem,
} from "./sessionLiveModel";
import {
  getSessionLive,
  sessionIdForAgent,
  sessionsVersion,
  subscribe,
  subscribeSessions,
} from "./sessionLiveRegistry";
import {
  canDrive,
  isSessionHost,
  myAccess,
  sessionActivityLine,
  sessionAgentChatter,
  sessionStream,
  splitParticipants,
} from "./sessionLiveSelectors";

export * from "./sessionLiveModel";
export * from "./sessionLiveSelectors";
export * from "./sessionLiveActions";
export {
  getSessionLive,
  isSessionLive,
  liveSessionIds,
  sessionIdForAgent,
  sessionsVersion,
  subscribeSessions,
  subscribe as subscribeSessionLive,
} from "./sessionLiveRegistry";

const NOOP_UNSUBSCRIBE = () => {};

/** Live state for one session. Passive — this does not open a socket. */
export function useSessionLive(
  sessionId: string | null | undefined,
): SessionLiveState {
  const id = sessionId ?? "";
  return useSyncExternalStore(
    (cb) => (id ? subscribe(id, cb) : NOOP_UNSUBSCRIBE),
    () => getSessionLive(id),
    () => getSessionLive(id),
  );
}

/** The external session a locally-running agent is shared as, or null.
 *
 *  A terminal pane knows its own PTY id and nothing else. This is how it finds
 *  out whether anyone is watching it — and therefore whether it should be
 *  wearing a participants strip at all. */
export function useSessionForAgent(
  agentSessionId: string | null | undefined,
): string | null {
  const version = useSyncExternalStore(
    subscribeSessions,
    sessionsVersion,
    sessionsVersion,
  );
  return useMemo(
    () => sessionIdForAgent(agentSessionId ?? ""),
    [agentSessionId, version],
  );
}

export function useSessionParticipants(
  sessionId: string | null | undefined,
): Participant[] {
  return useSessionLive(sessionId).participants;
}

/** Humans and agents, split for the two rows the roster renders. */
export function useSessionParticipantSplit(
  sessionId: string | null | undefined,
): { humans: Participant[]; agents: Participant[] } {
  const participants = useSessionParticipants(sessionId);
  return useMemo(() => splitParticipants(participants), [participants]);
}

export function useIsSessionHost(sessionId: string | null | undefined): boolean {
  return isSessionHost(useSessionLive(sessionId));
}

/** Whether the composer should be live. See `canDrive` — a courtesy, not the
 *  check that matters. */
export function useCanDrive(sessionId: string | null | undefined): boolean {
  return canDrive(useSessionLive(sessionId));
}

export function useMyAccess(sessionId: string | null | undefined): AccessLevel {
  return myAccess(useSessionLive(sessionId));
}

export function useSessionConnection(
  sessionId: string | null | undefined,
): SessionLiveConnectionStatus {
  return useSessionLive(sessionId).connection;
}

/** Participants currently typing, resolved to their records. */
export function useSessionTypingParticipants(
  sessionId: string | null | undefined,
): Participant[] {
  const state = useSessionLive(sessionId);
  return useMemo(
    () => state.participants.filter((p) => state.typing.has(p.id)),
    [state],
  );
}

export function useSessionActivity(
  sessionId: string | null | undefined,
): SessionActivity[] {
  return useSessionLive(sessionId).activity;
}

export function useSessionAgentChatter(
  sessionId: string | null | undefined,
): SessionActivity[] {
  const state = useSessionLive(sessionId);
  return useMemo(() => sessionAgentChatter(state), [state]);
}

/** The one compact line for a session row on the rail. */
export function useSessionActivityLine(
  sessionId: string | null | undefined,
): SessionActivity | null {
  const state = useSessionLive(sessionId);
  return useMemo(() => sessionActivityLine(state), [state]);
}

export function useSessionStream(
  sessionId: string | null | undefined,
): SessionStreamItem[] {
  const state = useSessionLive(sessionId);
  return useMemo(() => sessionStream(state), [state]);
}

/** Null while nobody has asked the desktop; `[]` when nothing is open. */
export function useSessionTunnels(
  sessionId: string | null | undefined,
): SessionTunnel[] | null {
  return useSessionLive(sessionId).tunnels;
}

export function useSessionShare(
  sessionId: string | null | undefined,
): SessionShare | null {
  return useSessionLive(sessionId).share;
}
