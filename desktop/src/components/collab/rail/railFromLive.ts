// Where the Session Live wire meets the rail.
//
// This is the only file in `collab/rail/` that knows the protocol exists.
// Everything else takes `RailPersonGroup[]` and renders it, which is what lets
// the fixture photograph the rail with no backend and what keeps the wording
// rules (`describeActivity`) out of the transport.
//
// Two things the wire doesn't carry, resolved here rather than faked:
//
//  - **Whose agent is that.** `Participant` has no owner field, but an agent's
//    `user_id` is the account whose desktop runs it, so an agent is matched to
//    the human participant sharing its `user_id`. When there is no such human
//    in the room, the agent stays unowned and reads as plain "Claude" — which
//    is true, rather than a guess with a name on it.
//  - **Decay.** `sessionLiveStore.sessionActivityLine` already ranks impact
//    over chatter, but nothing ages out, so a line landed at 09:00 is still on
//    the row at 17:00. The rail keeps the raw `SessionActivity[]` and lets
//    `pickActivity` apply both the ranking and the per-kind window.

import type {
  AccessLevel,
  Participant,
  ParticipantState,
} from "../../../lib/sessionLive";
import {
  sessionActivity,
  type SessionActivity,
  type SessionLiveState,
} from "../../../lib/sessionLiveStore";
import type { RailActivity, RailActor, RailSession } from "./railModel";

/** Static facts about a session that the live plane never carries — its title,
 *  whose it is, and when it last moved. They come from the session store /
 *  `/sync/sessions`, not from the socket. */
export type RailSessionMeta = {
  /** `external_id` — the id the live socket is opened on. */
  id: string;
  title: string;
  /** Participant id of the person this session belongs to. */
  ownerId: string;
  /** Epoch SECONDS of the last thing that happened, from history. Live traffic
   *  overrides it when there is any. */
  lastAt: number;
  /** An agent is mid-turn on this desktop. Known locally, not on the wire. */
  agentBusy?: boolean;
  /** What a visitor gets — `SessionLiveInfo.default_access` from the share
   *  record. Omit when the session hasn't said and the row will fall back to
   *  what the host's presence implies. */
  defaultAccess?: AccessLevel | null;
};

/** The wire's five states, plus the rail's sixth for someone not connected. */
function railState(p: Participant): ParticipantState {
  return p.state;
}

/**
 * Participants → actors, with agents attributed to their owners.
 *
 * `state` passes straight through: the protocol is explicit that the server
 * echoes what the client set and never infers it, so inferring it here would
 * put the rail at odds with the one place that is allowed to say.
 */
export function railActorsFromParticipants(list: Participant[]): RailActor[] {
  const humanByUser = new Map<string, string>();
  for (const p of list) if (p.kind === "human") humanByUser.set(p.user_id, p.id);
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    agentKind: p.agent_kind,
    avatar: p.avatar,
    ownerId: p.kind === "agent" ? humanByUser.get(p.user_id) ?? null : null,
    state: railState(p),
  }));
}

/** One store activity → one rail activity.
 *
 *  The two shapes agree field for field today, and the copy is deliberate
 *  anyway: `RailActivity` is what the components render and the fixture writes,
 *  and letting it become an alias for a store type would make every future
 *  change to the store a silent change to the rail. It is six fields. */
export function railActivityFrom(a: SessionActivity): RailActivity {
  return {
    id: a.id,
    kind: a.kind,
    fromId: a.fromId,
    toId: a.toId,
    intent: a.intent,
    ref: a.ref,
    text: a.text,
    severity: a.severity,
    at: a.at,
  };
}

export function railActivityFromLive(
  list: readonly SessionActivity[],
): RailActivity[] {
  return list.map(railActivityFrom);
}

/**
 * A session row, from what we know statically plus what the socket is saying.
 *
 * `joined` is "this desktop holds a connection", which is what the Join
 * affordance is really asking about — `you` is only set once the server has
 * answered `ready`, so a socket that is still connecting correctly reads as
 * not-yet-joined instead of flickering the control away and back.
 */
export function railSessionFromLive(
  meta: RailSessionMeta,
  live: SessionLiveState,
): RailSession {
  const participants = railActorsFromParticipants(live.participants);
  // `sessionActivity` is the store's own merge of `messages` + `impacts` into
  // one ordered stream. The rail reads that rather than the two lists, so a
  // message and a collision landing in the same second can't be ranked against
  // each other twice with two different answers.
  const activity = railActivityFromLive(sessionActivity(live));
  const newest = activity.reduce((max, a) => (a.at > max ? a.at : max), 0);
  const last = activity.length > 0 ? activity[activity.length - 1] : null;
  return {
    id: meta.id,
    title: meta.title,
    participants,
    // Who moved last: the newest thing on the wire, falling back to nobody
    // rather than to the owner — attributing a session's last move to its
    // owner when it was someone else's agent is the exact misreading a shared
    // session makes possible.
    lastActorId: last?.fromId ?? null,
    lastAt: Math.max(meta.lastAt, newest),
    activity,
    joined: live.you !== null,
    // Once you are actually in, your own participant record is the truth about
    // what you can do — the share record's default is only what a visitor
    // would have been given.
    access: live.you?.access ?? meta.defaultAccess ?? null,
    hostOnline: live.hostOnline,
    agentBusy: meta.agentBusy ?? false,
  };
}

/**
 * A session nobody has a socket open on — the ordinary state of everything
 * older than today.
 *
 * Not an error and not a loading state: it is a real row with a real title and
 * a real age, and the rail draws it as one quiet line.
 */
export function railSessionResting(meta: RailSessionMeta): RailSession {
  return {
    id: meta.id,
    title: meta.title,
    participants: [],
    lastActorId: null,
    lastAt: meta.lastAt,
    activity: [],
    joined: false,
    access: meta.defaultAccess ?? null,
    hostOnline: false,
    agentBusy: meta.agentBusy ?? false,
  };
}

/**
 * A person the rail knows about who is not in any session right now.
 *
 * The roster is a separate plane (the org's `/live/ws` presence), so this is
 * how someone from it becomes a rail actor: `offline`, because as far as the
 * session plane is concerned they are not here.
 */
export function railActorFromRoster(person: {
  id: string;
  name: string;
  avatar?: string | null;
}): RailActor {
  return {
    id: person.id,
    name: person.name,
    kind: "human",
    avatar: person.avatar ?? null,
    state: "offline",
  };
}

/**
 * The freshest presence we hold for a person, across every session they are in.
 *
 * Somebody can be watching one session and coding in another; the header dot
 * has one slot, so it takes the most engaged of the two. `offline` is the floor
 * and only survives if they are in nothing at all.
 */
export function mergePresence(
  base: RailActor,
  seen: RailActor[],
): RailActor {
  const RANK: Record<RailActor["state"], number> = {
    coding: 5,
    instructing: 4,
    talking: 3,
    watching: 2,
    idle: 1,
    offline: 0,
  };
  let best = base;
  for (const s of seen) {
    if (s.id !== base.id) continue;
    if (RANK[s.state] > RANK[best.state]) best = { ...base, state: s.state };
  }
  return best;
}
