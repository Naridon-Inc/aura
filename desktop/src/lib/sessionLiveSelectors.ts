// Session Live plane — reading a snapshot.
//
// Pure functions of one `SessionLiveState`. They are separate from the
// registry so a fixture can hand them a hand-written snapshot and check what a
// surface would say, without a socket, a Tauri mock or a React tree.
//
// Everything survives a session with zero participants and a totally offline
// cloud: the empty snapshot is a real object, so nothing here can be reached
// with `undefined`.

import type { AccessLevel, Participant } from "./sessionLive";
import {
  EMPTY_STREAM,
  type SessionActivity,
  type SessionLiveState,
  type SessionStreamItem,
} from "./sessionLiveModel";

/** Are *you* the host — i.e. is the agent running on this desktop? */
export function isSessionHost(state: SessionLiveState): boolean {
  return state.role === "host" || state.you?.role === "host";
}

/** What we are allowed to do here. Optimistic before `ready` lands: a composer
 *  that starts disabled and enables a beat later reads as broken. */
export function myAccess(state: SessionLiveState): AccessLevel {
  if (isSessionHost(state)) return "drive"; // the host cannot be demoted
  return state.you?.access ?? "drive";
}

/** Whether to leave the composer on. NOT the enforcement — the server drops a
 *  `msg` from a `watch` participant and answers `error`. This only spares
 *  someone typing a paragraph that was never going to arrive. */
export function canDrive(state: SessionLiveState): boolean {
  return myAccess(state) === "drive";
}

export function splitParticipants(list: readonly Participant[]): {
  humans: Participant[];
  agents: Participant[];
} {
  const humans: Participant[] = [];
  const agents: Participant[] = [];
  for (const p of list) {
    if (p.kind === "agent") agents.push(p);
    else humans.push(p);
  }
  return { humans, agents };
}

function isAgent(state: SessionLiveState, id: string): boolean {
  return state.participants.find((p) => p.id === id)?.kind === "agent";
}

/** The recent `msg` + `impact` stream, oldest first. */
export function sessionActivity(state: SessionLiveState): SessionActivity[] {
  return state.activity;
}

/** Agent-to-agent traffic: messages whose sender is an agent, plus every
 *  collision (only agents raise those). This is the point of the plane. */
export function sessionAgentChatter(state: SessionLiveState): SessionActivity[] {
  const all = state.activity;
  const out = all.filter((a) => a.kind === "impact" || isAgent(state, a.fromId));
  return out.length === all.length ? all : out;
}

function rank(a: SessionActivity): number {
  if (a.kind === "impact") return 3;
  if (a.intent === "instruct" || a.intent === "handoff") return 2;
  if (a.intent === "ask" || a.intent === "tell") return 1;
  return 0;
}

/**
 * The one line a session row shows: highest rank wins, latest breaks the tie.
 * A collision outranks ordinary chatter because "we are both editing this"
 * matters more than the last thing anyone said.
 *
 * Ageing is deliberately NOT applied here — the rail's `pickActivity` owns the
 * per-kind window, and applying a second one in the store would mean two
 * places decide when a line goes quiet.
 */
export function sessionActivityLine(
  state: SessionLiveState,
): SessionActivity | null {
  let best: SessionActivity | null = null;
  let bestRank = -1;
  for (const a of state.activity) {
    const r = rank(a);
    if (r > bestRank || (r === bestRank && best !== null && a.at >= best.at)) {
      best = a;
      bestRank = r;
    }
  }
  return best;
}

/** Transcript and messages interleaved by seq — the shared stream a session
 *  panel renders. */
export function sessionStream(state: SessionLiveState): SessionStreamItem[] {
  if (state.entries.length === 0 && state.messages.length === 0) {
    return EMPTY_STREAM;
  }
  const out: SessionStreamItem[] = [];
  for (const entry of state.entries) out.push({ kind: "entry", entry });
  for (const msg of state.messages) out.push({ kind: "msg", msg });
  out.sort((a, b) => {
    const as = a.kind === "msg" ? a.msg.seq : a.entry.seq;
    const bs = b.kind === "msg" ? b.msg.seq : b.entry.seq;
    if (as !== bs) return as - bs;
    // Seeded history can arrive without a seq; time keeps it in order.
    const at = a.kind === "msg" ? a.msg.at : a.entry.at;
    const bt = b.kind === "msg" ? b.msg.at : b.entry.at;
    return at - bt;
  });
  return out;
}
