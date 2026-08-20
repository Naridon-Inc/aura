// A real-looking shared session, with no backend behind it.
//
// Two people in different places, each with their own Claude, working the
// same rate-limit bug. It exists so the collab surfaces can be rendered and
// photographed without a socket — and so every one of the six sender/recipient
// permutations in the protocol has a line in it you can point at:
//
//   human → own agent      seq 120 (Ashiq briefs his Claude)
//   human → peer's agent   seq 124 (Shahabas instructs Ashiq's Claude)
//   agent → agent          seq 126 (Shahabas's Claude warns Ashiq's Claude)
//   human → human          seq 127 (Ashiq hands the rollout to Shahabas)
//   agent → human          seq 129 (Ashiq's Claude answers Shahabas)
//   anyone → everyone      seq 123 (Shahabas says hello to the room)
//
// Nothing in the components reads this file; it is fixture data, and it stays
// out of the components on purpose.

import type {
  EntryRole,
  MsgIntent,
  Participant,
  SessionLiveRef,
} from "../../lib/sessionLive";
import type { SessionStreamItem } from "./collabTypes";

const NOW = Math.floor(Date.now() / 1000);

export const ashiq: Participant = {
  id: "p_7f3a",
  user_id: "u_101",
  name: "Ashiq",
  avatar: null,
  kind: "human",
  agent_kind: null,
  role: "host",
  access: "drive",
  state: "instructing",
  since: NOW - 1620,
};

export const ashiqClaude: Participant = {
  id: "p_7f3b",
  user_id: "u_101",
  name: "Claude",
  avatar: null,
  kind: "agent",
  agent_kind: "claude",
  role: "host",
  access: "drive",
  state: "coding",
  since: NOW - 1590,
};

export const shahabas: Participant = {
  id: "p_2c9d",
  user_id: "u_204",
  name: "Shahabas",
  avatar: null,
  kind: "human",
  agent_kind: null,
  role: "guest",
  access: "drive",
  state: "talking",
  since: NOW - 940,
};

export const shahabasClaude: Participant = {
  id: "p_2c9e",
  user_id: "u_204",
  name: "Claude",
  avatar: null,
  kind: "agent",
  agent_kind: "claude",
  role: "guest",
  access: "drive",
  state: "watching",
  since: NOW - 930,
};

export const fixtureParticipants: Participant[] = [
  ashiq,
  ashiqClaude,
  shahabas,
  shahabasClaude,
];

function entry(
  id: string,
  seq: number,
  role: EntryRole,
  author: Participant,
  text: string,
  ago: number,
): SessionStreamItem {
  return {
    kind: "entry",
    entry: {
      id,
      seq,
      role,
      author: { id: author.id, name: author.name, kind: author.kind },
      text,
      at: NOW - ago,
    },
  };
}

function msg(
  seq: number,
  from: Participant,
  to: Participant | null,
  intent: MsgIntent,
  text: string,
  ago: number,
  refs: SessionLiveRef[] = [],
): SessionStreamItem {
  return {
    kind: "msg",
    msg: {
      id: `m_${seq}`,
      from: from.id,
      to: to ? to.id : null,
      text,
      intent,
      refs,
      at: NOW - ago,
    },
  };
}

const RETRY_REF = { symbol: "retry_logic", file: "aura-cli/src/retry.rs" };
const CEILING_REF = { symbol: "backoff_ceiling", file: "aura-cli/src/retry.rs" };

export const fixtureStream: SessionStreamItem[] = [
  entry(
    "e_9c0",
    120,
    "user",
    ashiq,
    "The rate-limit retries are firing three times a second whenever the API 429s. Can you look at `retry_logic`?",
    1580,
  ),
  entry(
    "e_9c1",
    121,
    "assistant",
    ashiqClaude,
    "Found it. `retry_logic` in `aura-cli/src/retry.rs` retries on a fixed 300ms timer with no backoff, so a sustained 429 turns into three requests a second forever. I'll put exponential backoff behind it.",
    1540,
  ),
  entry("e_9c2", 122, "tool", ashiqClaude, "Read aura-cli/src/retry.rs. 218 lines", 1535),
  msg(
    123,
    shahabas,
    null,
    "chat",
    "Just joined. Mo says the 429s are hitting prod too, not just our boxes.",
    920,
  ),
  msg(
    124,
    shahabas,
    ashiqClaude,
    "instruct",
    "Before you touch the timer: check whether the 429 body carries a `Retry-After` header. If it does, honour that instead of guessing a delay.",
    860,
    [RETRY_REF],
  ),
  entry(
    "e_9c3",
    125,
    "assistant",
    ashiqClaude,
    "Good call. The 429 responses do carry `Retry-After`, in seconds. Switching to honour it, with exponential backoff only as the fallback when the header is missing.",
    810,
  ),
  msg(
    126,
    shahabasClaude,
    ashiqClaude,
    "tell",
    "Heads-up from the other branch: `backoff_ceiling` was raised to 30s on `feat/rate-limits` about an hour ago. If you cap at 10s here, the two will disagree the moment they merge.",
    700,
    [CEILING_REF],
  ),
  msg(
    127,
    ashiq,
    shahabas,
    "handoff",
    "@shahabas the prod rollout is yours. I'll finish the CLI change and push it in about twenty minutes.",
    430,
  ),
  msg(
    128,
    shahabas,
    ashiq,
    "tell",
    "Got it. I'll stage it behind the flag and watch the error rate for an hour before it goes wide.",
    380,
  ),
  msg(
    129,
    ashiqClaude,
    shahabas,
    "tell",
    "For the rollout: the ceiling is now 30s to match `feat/rate-limits`, and the fallback backoff starts at 500ms and doubles. Worst case a client waits 30s between attempts.",
    240,
    [CEILING_REF],
  ),
  entry(
    "e_9c4",
    130,
    "assistant",
    ashiqClaude,
    "Rewriting `retry_logic` to parse `Retry-After`, clamp it to the 30s ceiling, and fall back to exponential backoff",
    25,
  ),
];

/** Everything a harness needs to render every surface in this folder. */
export const collabFixture = {
  sessionId: "sess_4f8a1c",
  /** The screenshot is taken from Ashiq's machine. */
  youId: ashiq.id,
  hostOnline: true,
  participants: fixtureParticipants,
  items: fixtureStream,
  /** The last entry is still being produced. */
  streamingIds: ["e_9c4"],
  /** Shahabas is mid-reply; Ashiq's Claude is mid-edit. */
  typing: [shahabas],
  working: [ashiqClaude],
};

/** A bigger room, for photographing the "+N" overflow. Same two people plus
 *  three teammates who dropped in to watch a build go out. */
export const crowdedFixtureParticipants: Participant[] = [
  ...fixtureParticipants,
  {
    id: "p_5a11",
    user_id: "u_310",
    name: "Nadia",
    avatar: null,
    kind: "human",
    agent_kind: null,
    role: "guest",
    access: "watch",
    state: "watching",
    since: NOW - 300,
  },
  {
    id: "p_5a12",
    user_id: "u_311",
    name: "Tom",
    avatar: null,
    kind: "human",
    agent_kind: null,
    role: "guest",
    access: "watch",
    state: "idle",
    since: NOW - 280,
  },
  {
    id: "p_5a13",
    user_id: "u_310",
    name: "Gemini",
    avatar: null,
    kind: "agent",
    agent_kind: "gemini",
    role: "guest",
    access: "drive",
    state: "coding",
    since: NOW - 260,
  },
];
