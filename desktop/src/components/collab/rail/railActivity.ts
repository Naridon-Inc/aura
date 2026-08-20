// Which one thing a session row says, and how it reads.
//
// Two rules, both here because they are the difference between a rail you can
// glance at and a rail you have to ignore:
//
//   RANK   an impact outranks an instruction outranks chatter. "We are both
//          editing this" is worth interrupting someone for; "thinking about the
//          retry path" is not.
//   DECAY  everything ages out, by kind. Chatter is stale in under a minute; an
//          impact is worth five. Past its window the row simply goes quiet —
//          there is no "dismiss", because nobody should have to tidy up a
//          sidebar.
//
// Pure, and separate from `railModel`'s shaping, so the two things a reviewer
// would actually argue about are in one file with their reasoning next to them.

import type { RailActivity, RailActor } from "./railModel";

/* ── which activity gets the one line ─────────────────────────────── */

/** How long a thing stays worth saying, by what kind of thing it is.
 *
 *  Chatter goes stale fast — two agents thinking out loud is interesting for
 *  under a minute and is noise after that. An instruction lasts longer because
 *  it changed what the session is doing. An impact lasts longest because it is
 *  the one line here you might have to act on. Past its window the row falls
 *  silent, which is the whole reason the rail can afford to show any of this. */
export const ACTIVITY_TTL_SECS = {
  impact: 300,
  instruct: 90,
  handoff: 90,
  ask: 60,
  tell: 60,
  chat: 45,
} as const;

/** Seconds this activity stays on the row. */
export function activityTtl(a: RailActivity): number {
  if (a.kind === "impact") return ACTIVITY_TTL_SECS.impact;
  return ACTIVITY_TTL_SECS[a.intent];
}

/** Still worth a line at `nowSecs`? */
export function isActivityFresh(a: RailActivity, nowSecs: number): boolean {
  return nowSecs - a.at <= activityTtl(a);
}

/** How loudly a thing deserves the row. Higher wins. */
export function activityRank(a: RailActivity): number {
  if (a.kind === "impact") return 3;
  if (a.intent === "instruct" || a.intent === "handoff") return 2;
  if (a.intent === "ask" || a.intent === "tell") return 1;
  return 0;
}

/** The one line, or nothing.
 *
 *  One line, latest wins, impact outranks chatter — in that order, because a
 *  row that renders every frame is a log, and a log in a sidebar is a
 *  firehose. Anything past its window is dropped first, so a busy morning
 *  can't leave a stale sentence pinned under a session for the rest of the
 *  day. */
export function pickActivity(
  activity: RailActivity[],
  nowSecs: number,
): RailActivity | null {
  let best: RailActivity | null = null;
  let bestRank = -1;
  for (const a of activity) {
    if (!isActivityFresh(a, nowSecs)) continue;
    const rank = activityRank(a);
    if (rank > bestRank || (rank === bestRank && best !== null && a.at > best.at)) {
      best = a;
      bestRank = rank;
    }
  }
  return best;
}

/* ── wording ──────────────────────────────────────────────────────── */

/** `Shahabas` → `Shahabas’s`. Typographic apostrophe, as everywhere else. */
export function possessive(name: string): string {
  return `${name}’s`;
}

/** An actor's name, qualified by whose it is when that matters.
 *
 *  Two people in a session both running Claude is the ordinary case for this
 *  plane, so "Claude" alone is ambiguous exactly when the feature is working.
 *  The compact line still says "Claude" — the row has ~180px — and the hover
 *  text says whose. */
export function actorLabel(
  actor: RailActor | undefined,
  byId: Map<string, RailActor>,
  qualified: boolean,
): string {
  if (!actor) return "Someone";
  if (!qualified || actor.kind !== "agent") return actor.name;
  const owner = actor.ownerId ? byId.get(actor.ownerId) : undefined;
  return owner ? `${possessive(owner.name)} ${actor.name}` : actor.name;
}

/** The activity line, split into the parts the row paints differently. */
export type RailActivityCopy = {
  /** Who, and what they did: `Shahabas’s Claude flagged`, `Claude → Claude:`. */
  who: string;
  /** Their own words. Empty for an impact. */
  said: string;
  /** The symbol or file it is about, in mono. Null when there isn't one. */
  ref: string | null;
  /** The same line, unabbreviated, for the row's hover text. */
  full: string;
};

/** Turn one activity into one readable line.
 *
 *  An impact names whose agent noticed it and what it touched, because both
 *  halves are the reason you'd look. A message is rendered as the arrow it is
 *  — `A → B: what they said` — which is the only shape that reads the same for
 *  a human instructing an agent, an agent instructing another person's agent,
 *  and two people talking. A broadcast has no arrow because it has no
 *  recipient. */
export function describeActivity(
  a: RailActivity,
  byId: Map<string, RailActor>,
): RailActivityCopy {
  const from = byId.get(a.fromId);
  const to = a.toId ? byId.get(a.toId) : undefined;

  if (a.kind === "impact") {
    const short = `${actorLabel(from, byId, true)} flagged`;
    const ref = a.ref ?? null;
    return {
      who: short,
      said: ref ? "" : "something you both touch",
      ref,
      full: ref ? `${short} ${ref}` : `${short} something you both touch`,
    };
  }

  const fromShort = actorLabel(from, byId, false);
  const fromLong = actorLabel(from, byId, true);
  const who = to
    ? `${fromShort} → ${actorLabel(to, byId, false)}:`
    : `${fromShort}:`;
  const whoLong = to
    ? `${fromLong} → ${actorLabel(to, byId, true)}:`
    : `${fromLong}:`;
  return { who, said: a.text, ref: null, full: `${whoLong} ${a.text}`.trim() };
}
