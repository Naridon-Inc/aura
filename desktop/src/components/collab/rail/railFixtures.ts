// A rail with real people in it, so the thing can be photographed without a
// backend.
//
// This is fixture data for a screenshot harness and for eyeballing states that
// are hard to produce on demand (an impact landing, two agents mid-exchange, a
// teammate who is offline). It is NOT a fallback: nothing in `PeopleRail` or
// its children imports this file, so an app that can't reach the live plane
// renders the loading or error state and says so, rather than quietly showing
// invented teammates.
//
// Everything is built relative to a `now` you pass in, so the ages read
// naturally ("now", "4m", "2d") whenever the shot is taken. Pass the same value
// to `PeopleRail`'s `nowSecs` and the times, the decay and the shot all agree.
//
// The harness must wrap the rail in `TooltipProvider` (components/ui/tooltip) —
// the presence dot uses the app's real tooltip, and the app mounts that
// provider at the root.

import type { RailActivity, RailActor, RailPersonGroup } from "./railModel";

const DAY = 86_400;

/** Wall clock in epoch SECONDS — the unit the protocol stamps `at` in. */
export function railFixtureNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** The session the hero shot has open. */
export const RAIL_FIXTURE_ACTIVE_SESSION_ID = "s_retry";

function actors(): Record<string, RailActor> {
  return {
    ashiq: {
      id: "p_ashiq",
      name: "Ashiq",
      kind: "human",
      avatar: null,
      state: "instructing",
    },
    ashiqClaude: {
      id: "p_ashiq_claude",
      name: "Claude",
      kind: "agent",
      agentKind: "claude",
      ownerId: "p_ashiq",
      state: "coding",
    },
    shahabas: {
      id: "p_shahabas",
      name: "Shahabas",
      kind: "human",
      avatar: null,
      state: "watching",
    },
    shahabasClaude: {
      id: "p_shahabas_claude",
      name: "Claude",
      kind: "agent",
      agentKind: "claude",
      ownerId: "p_shahabas",
      state: "talking",
    },
    meera: {
      id: "p_meera",
      name: "Meera",
      kind: "human",
      avatar: null,
      state: "offline",
    },
  };
}

/**
 * The hero: you (Ashiq), a teammate mid-session (Shahabas), and a teammate who
 * is off (Meera, no sessions).
 *
 * Between them the shot carries every state the rail has to draw — a session
 * with two people and their two agents in it, an impact one agent raised about
 * something the other side touches, two agents talking to each other, a quiet
 * session that has decayed back to one line, a session you can join, a session
 * whose host is away so you can only watch, and a person with nothing open.
 */
export function railFixtureGroups(
  nowSecs: number = railFixtureNow(),
): RailPersonGroup[] {
  const a = actors();

  // Ashiq's live session. Both people and both agents are in it. Two things
  // happened recently: his Claude said something 15 seconds ago, and Shahabas's
  // Claude raised an impact 25 seconds ago. The impact is older and it still
  // wins the line — that is `pickActivity`'s rule, visible in the shot.
  const retryActivity: RailActivity[] = [
    {
      id: "seq_311",
      kind: "impact",
      fromId: a.shahabasClaude.id,
      toId: null,
      intent: "tell",
      ref: "retry_logic",
      text: "",
      severity: "direct",
      at: nowSecs - 25,
    },
    {
      id: "seq_309",
      kind: "message",
      fromId: a.ashiqClaude.id,
      toId: a.shahabasClaude.id,
      intent: "chat",
      ref: null,
      text: "planning the retry path",
      at: nowSecs - 15,
    },
    // Past its window — kept here on purpose. A rail that never drops anything
    // would still be showing this line an hour later.
    {
      id: "seq_240",
      kind: "message",
      fromId: a.ashiq.id,
      toId: a.ashiqClaude.id,
      intent: "instruct",
      ref: null,
      text: "back off exponentially instead of retrying flat",
      at: nowSecs - 20 * 60,
    },
  ];

  // Shahabas's live session — his Claude and Ashiq's Claude are talking to each
  // other about it. This is the row that says agent-to-agent traffic out loud.
  const pushActivity: RailActivity[] = [
    {
      id: "seq_418",
      kind: "message",
      fromId: a.shahabasClaude.id,
      toId: a.ashiqClaude.id,
      intent: "chat",
      ref: null,
      text: "checking how the phone gets woken up",
      at: nowSecs - 12,
    },
    {
      id: "seq_402",
      kind: "message",
      fromId: a.shahabas.id,
      toId: a.shahabasClaude.id,
      intent: "instruct",
      ref: null,
      text: "start from the delivery receipt, not the send",
      at: nowSecs - 9 * 60,
    },
  ];

  return [
    {
      person: a.ashiq,
      isYou: true,
      sessions: [
        {
          id: "s_retry",
          title: "Retries when the API rate-limits us",
          participants: [
            a.ashiq,
            a.ashiqClaude,
            a.shahabas,
            a.shahabasClaude,
          ],
          lastActorId: a.shahabasClaude.id,
          lastAt: nowSecs - 15,
          activity: retryActivity,
          joined: true,
          hostOnline: true,
          agentBusy: true,
        },
        {
          id: "s_updates",
          title: "Updates page 404s right after a release",
          participants: [],
          lastActorId: a.ashiq.id,
          lastAt: nowSecs - 2 * DAY,
          activity: [],
          joined: true,
          hostOnline: true,
          agentBusy: false,
        },
      ],
    },
    {
      person: a.shahabas,
      isYou: false,
      sessions: [
        {
          id: "s_push",
          title: "Waking the phone app for a push",
          participants: [a.shahabas, a.shahabasClaude, a.ashiqClaude],
          lastActorId: a.shahabasClaude.id,
          lastAt: nowSecs - 12,
          activity: pushActivity,
          joined: false,
          // Open to a turn, so the row offers "Join".
          access: "drive",
          hostOnline: true,
          agentBusy: true,
        },
        {
          id: "s_linux",
          title: "Linux build shipped the old screens",
          participants: [],
          lastActorId: a.shahabas.id,
          lastAt: nowSecs - 5 * DAY,
          activity: [],
          joined: false,
          // Watch-only AND nobody running it — the row offers "Watch".
          access: "watch",
          hostOnline: false,
          agentBusy: false,
        },
      ],
    },
    {
      person: a.meera,
      isYou: false,
      sessions: [],
    },
  ];
}

/**
 * You, working alone — nobody else on the project, one quiet session.
 *
 * The state the rail spends most of its life in, and the one it is easiest to
 * get wrong: an empty right-hand column and a rail that looks broken rather
 * than calm.
 */
export function railFixtureQuiet(
  nowSecs: number = railFixtureNow(),
): RailPersonGroup[] {
  const a = actors();
  return [
    {
      person: { ...a.ashiq, state: "coding" },
      isYou: true,
      sessions: [
        {
          id: "s_solo",
          title: "Tidy up the settings screen",
          participants: [
            { ...a.ashiq, state: "coding" },
            { ...a.ashiqClaude, state: "coding" },
          ],
          lastActorId: a.ashiqClaude.id,
          lastAt: nowSecs - 3 * 60,
          activity: [],
          joined: true,
          hostOnline: true,
          agentBusy: true,
        },
      ],
    },
  ];
}

/** A project nobody has opened a session in yet. */
export function railFixtureEmpty(): RailPersonGroup[] {
  return [];
}
