// shareFixtures — realistic stand-ins for the share / join / tunnel surfaces,
// so a harness can photograph every state with no cloud, no socket and no host
// machine anywhere.
//
// THESE ARE FIXTURES AND LIVE ONLY HERE. No component in this folder holds a
// hard-coded person, port or session; every one of them takes what it renders
// as props. That separation is the point — a component that carries its own
// sample data photographs beautifully and then ships a lie.
//
// Timestamps are anchored to load time rather than frozen, so a row reads
// "14m" whenever the shot is taken instead of "1y" and a session that opened
// "just now" doesn't age into nonsense between one screenshot and the next.

import type {
  AccessLevel,
  JoinFailure,
  JoinPreview,
  Participant,
  SessionTunnel,
  SharedSession,
} from "./shareTypes";
import { tunnelReach } from "./shareTypes";

const NOW = Date.now();
const MIN = 60_000;
/** Epoch SECONDS — the shape `Participant.since` carries on the wire. */
const secsAgo = (mins: number) => Math.floor((NOW - mins * MIN) / 1000);

/** The person whose machine the session runs on. Always drives; the level
 *  control on their row is locked, which is one of the states worth a shot. */
export const fixtureHost: Participant = {
  id: "p_7f3a",
  user_id: "u_1042",
  name: "Ashiq",
  avatar: null,
  kind: "human",
  agent_kind: null,
  role: "host",
  access: "drive",
  state: "instructing",
  since: secsAgo(52),
};

/** A teammate who can drive — sends messages, instructs the agents, on Ashiq's
 *  machine. */
export const fixtureDriver: Participant = {
  id: "p_2b91",
  user_id: "u_2277",
  name: "Shahabas",
  avatar: null,
  kind: "human",
  agent_kind: null,
  role: "guest",
  access: "drive",
  state: "talking",
  since: secsAgo(18),
};

/** A teammate who can only watch — the state that has to be visible to THEM,
 *  or a dead composer reads as a broken app. */
export const fixtureWatcher: Participant = {
  id: "p_5d04",
  user_id: "u_3391",
  name: "Nasrin",
  avatar: null,
  kind: "human",
  agent_kind: null,
  role: "guest",
  access: "watch",
  state: "watching",
  since: secsAgo(6),
};

/** The agent actually doing the work. Its access row is locked with a reason —
 *  an agent is instructed, it doesn't instruct. */
export const fixtureAgent: Participant = {
  id: "p_a11e",
  user_id: "u_1042",
  name: "Claude",
  avatar: null,
  kind: "agent",
  agent_kind: "claude",
  role: "guest",
  access: "watch",
  state: "coding",
  since: secsAgo(49),
};

export const fixtureParticipants: Participant[] = [
  fixtureHost,
  fixtureDriver,
  fixtureWatcher,
  fixtureAgent,
];

/** Two guests at two different levels, which is the arrangement the access
 *  list exists to make legible at a glance. */
export const fixtureAccess: Record<string, AccessLevel> = {
  [fixtureHost.id]: "drive",
  [fixtureDriver.id]: "drive",
  [fixtureWatcher.id]: "watch",
  [fixtureAgent.id]: "watch",
};

export const fixtureSharedSession: SharedSession = {
  externalId: "sess_9f2c41ab7d",
  title: "Rate-limit retries on the billing client",
  hostMachine: "Ashiq's MacBook Pro",
  hostName: "Ashiq",
  repoName: "aura-sovereign",
  link: "https://app.auravcs.com/join/k3f9qa",
  code: "k3f9qa",
  defaultAccess: "watch",
  participants: fixtureParticipants,
  access: fixtureAccess,
};

/** The same session before anyone has been let in — for the "only you are in
 *  here" state. `null` is what the panel takes, so this is just the marker. */
export const fixtureUnsharedSession: SharedSession | null = null;

export const fixtureTunnels: SessionTunnel[] = [
  {
    code: "k3f9qa",
    port: 3000,
    label: "the web app",
    url: "https://app.auravcs.com/t/k3f9qa/",
    opened_at: NOW - 14 * MIN,
  },
  {
    code: "q7m2xt",
    port: 8787,
    label: "the billing API",
    url: "https://app.auravcs.com/t/q7m2xt/",
    opened_at: NOW - 3 * MIN,
  },
];

/** Who those two ports are reachable by — the session's own people, which is
 *  what `TunnelManager` takes. Derived, not hand-listed, so it can't drift from
 *  the roster above. */
export const fixtureTunnelReach: string[] = tunnelReach(fixtureParticipants);

/** What Nasrin sees before she commits to joining. */
export const fixtureJoinPreview: JoinPreview = {
  externalId: fixtureSharedSession.externalId,
  title: fixtureSharedSession.title,
  hostName: fixtureSharedSession.hostName,
  hostMachine: fixtureSharedSession.hostMachine,
  repoName: fixtureSharedSession.repoName,
  hostOnline: true,
  participants: [fixtureHost, fixtureDriver, fixtureAgent],
  yourAccess: "watch",
};

/** The same preview with the host away — the caution state, not a refusal: the
 *  protocol keeps the session open and holds what you send until they return. */
export const fixtureJoinPreviewHostAway: JoinPreview = {
  ...fixtureJoinPreview,
  hostOnline: false,
};

/** Every way getting in can fail, so each one can be photographed with the
 *  wording it actually ships with. */
export const fixtureJoinFailures: Record<string, JoinFailure> = {
  badCode: { kind: "not-found" },
  ended: { kind: "ended" },
  wrongTeam: { kind: "not-a-member", detail: "Naridon" },
  unknown: {
    kind: "unknown",
    detail: "Couldn't reach Aura Cloud. Check your connection and try again.",
  },
};

/** Ports the session knows the state of, for `TunnelText` / `TunnelChip`. The
 *  closed one is deliberately included: a chip that has gone dead is a state
 *  worth seeing, and the one most likely to be got wrong. */
export const fixtureTunnelStatuses: Record<number, "open" | "closed" | "unknown"> = {
  3000: "open",
  8787: "open",
  5173: "closed",
};

export const fixtureTunnelLabels: Record<number, string> = {
  3000: "the web app",
  8787: "the billing API",
};

/** A message body carrying two live addresses and one that has been stopped —
 *  the input `TunnelText` is built for. */
export const fixtureMessageWithTunnels =
  "pushed the fix. Check aura://localhost:3000 and the API on aura://localhost:8787. " +
  "aura://localhost:5173 is gone, I stopped that one.";
