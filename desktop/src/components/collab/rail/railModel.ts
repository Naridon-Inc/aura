// What the rail knows about people, their sessions, and what just happened.
//
// This is the rail's *view* model, not the wire. The Session Live plane speaks
// `Participant` / `Entry` / `msg` / `impact` frames (docs/collab/
// SESSION_LIVE_PROTOCOL.md); this file speaks in the terms the sidebar renders
// — a person, the sessions under them, the one line worth showing, and who is
// in the room. `railFromLive.ts` is the only place the two meet, so every
// component here stays a pure function of something a screenshot can produce.
//
// Everything below is pure and has no React in it. The two rules that decide
// whether this rail is calm or a firehose — which activity wins a row, and how
// long it stays — live next door in `railActivity.ts`, so they can be argued
// with on their own.

/** How present someone is.
 *
 *  The first five are the protocol's own `Participant.state`. `offline` is the
 *  rail's addition and is not a wire value: the sidebar has to draw a teammate
 *  who is in the project but not in any session right now, and the wire only
 *  ever describes people who are connected. */
export type RailPresenceState =
  | "coding"
  | "instructing"
  | "talking"
  | "watching"
  | "idle"
  | "offline";

/** A person or an agent — the two kinds of thing that can be in a session. */
export type RailActor = {
  /** Stable for as long as this actor is on screen. Participant id when the
   *  actor came off the wire; a roster id for someone who is merely known. */
  id: string;
  /** What we call them. "Ashiq". "Claude". Never an id. */
  name: string;
  kind: "human" | "agent";
  /** Which agent this is — `claude`, `gemini`, `codex`. Humans leave it null.
   *  Feeds the brand mark, so an unknown value degrades to a neutral tile
   *  rather than to nothing. */
  agentKind?: string | null;
  /** A profile photo, when we have one. The deterministic monogram is the
   *  fallback, so a missing or broken photo is never a hole. */
  avatar?: string | null;
  /** Whose agent this is. An agent without an owner is nobody's, which is how
   *  "Shahabas’s Claude" degrades to "Claude" instead of to a lie. */
  ownerId?: string | null;
  state: RailPresenceState;
};

/** One thing that happened in a session, recently enough to still say.
 *
 *  Structured rather than a pre-written sentence: the wording is a rendering
 *  decision (`describeActivity` below), and baking it at ingest would put the
 *  copy in the adapter where no component can change it and no fixture can
 *  exercise it. */
export type RailActivity = {
  /** Dedupe key — the frame's `seq`, or the entry id. */
  id: string;
  /** An impact is a collision someone noticed. A message is anyone talking to
   *  anyone: human→agent, agent→agent, or the room. */
  kind: "impact" | "message";
  /** Participant id of the speaker. */
  fromId: string;
  /** Who it was addressed to; null means the room. */
  toId?: string | null;
  /** How loud the message was meant to be. Impacts carry `tell`. */
  intent: "instruct" | "ask" | "tell" | "handoff" | "chat";
  /** The symbol or file the line is about, when there is one. */
  ref?: string | null;
  /** Their own words. Empty for an impact — nobody said anything, something
   *  was noticed. */
  text: string;
  /** How direct the collision is. Impacts only. */
  severity?: "direct" | "likely" | null;
  /** Epoch SECONDS, matching the protocol's `at`. */
  at: number;
};

/** What joining would actually get you.
 *
 *  Mirrors the wire's `AccessLevel`, kept here as a rail word so the button's
 *  copy doesn't depend on a transport type. `drive` means you could take a
 *  turn; `watch` means you could follow along and nothing more. */
export type RailAccess = "watch" | "drive";

/** A session as the rail draws it: one row, and what is going on inside it. */
export type RailSession = {
  /** The session's `external_id` — the same one the live socket is opened on. */
  id: string;
  title: string;
  /** Everyone in the room right now, humans and agents alike. Empty when
   *  nobody is connected, which is the ordinary state of an old session. */
  participants: RailActor[];
  /** Who moved last, for the trailing avatar. Null when we can't attribute it. */
  lastActorId?: string | null;
  /** Epoch SECONDS of the last thing that happened here. */
  lastAt: number;
  /** Everything recent enough to still be worth a line. The rail picks one;
   *  it never renders the list. */
  activity: RailActivity[];
  /** Are you already in this session? Decides whether the row offers a way in. */
  joined: boolean;
  /** What you'd get by joining, when the session has said. Undefined means we
   *  haven't been told, and the row falls back to what it can see — an offer
   *  the rail can't keep is worse than a vaguer one. */
  access?: RailAccess | null;
  /** Is the desktop that actually runs the agent connected? A session whose
   *  host is away can be followed but not driven, and saying so up front beats
   *  letting someone type into a room with nothing listening. */
  hostOnline: boolean;
  /** An agent is mid-turn here. Drives the house loader on the row's glyph. */
  agentBusy: boolean;
};

/** One person, and the sessions that are theirs. */
export type RailPersonGroup = {
  person: RailActor;
  /** The viewer's own group. Sorts first, always. */
  isYou: boolean;
  sessions: RailSession[];
};

/* ── presence ─────────────────────────────────────────────────────── */

/** What the dot means, in words anyone can read.
 *
 *  No jargon and no verbs from the wire — "instructing" is a protocol word,
 *  "telling an agent what to do" is what it is. */
export function presenceLabel(state: RailPresenceState): string {
  switch (state) {
    case "coding":
      return "Writing code";
    case "instructing":
      return "Telling an agent what to do";
    case "talking":
      return "In the conversation";
    case "watching":
      return "Watching along";
    case "idle":
      return "Here, nothing going on";
    case "offline":
      return "Not here right now";
  }
}

/** `Shahabas — watching along`. The dot's whole tooltip. */
export function presenceTitle(name: string, state: RailPresenceState): string {
  const label = presenceLabel(state);
  return `${name} · ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** How the dot is painted.
 *
 *  Deliberately three answers, not six. A 7px disc can carry "live and doing
 *  something", "here but along for the ride", and "not here" — asking it to
 *  also distinguish coding from instructing from talking means six colours on
 *  a rail whose whole job is to stay quiet, and the reader would still have to
 *  hover to learn which was which. The exact verb is the tooltip's; the colour
 *  answers the only question a glance is asking. Aura's green throughout —
 *  amber means "waiting on you" in this rail, and red means broken. */
export function presenceInk(state: RailPresenceState): {
  color: string;
  filled: boolean;
} {
  switch (state) {
    case "coding":
    case "instructing":
    case "talking":
      return { color: "var(--color-accent-green)", filled: true };
    case "watching":
      return { color: "var(--color-accent-green)", filled: false };
    case "idle":
      return { color: "var(--color-text-4)", filled: true };
    case "offline":
      return { color: "var(--color-text-5)", filled: false };
  }
}

/** Is this person connected to anything at all? */
export function isPresent(state: RailPresenceState): boolean {
  return state !== "offline";
}

/* ── shaping the rail ─────────────────────────────────────────────── */

/** Index every actor in every session, plus the group owners themselves.
 *
 *  One map for the whole rail: an activity in one session can name a person
 *  whose own group is somewhere else entirely (that is the point of the
 *  plane), so a per-session lookup would render half these lines as
 *  "Someone". */
export function indexActors(groups: RailPersonGroup[]): Map<string, RailActor> {
  const byId = new Map<string, RailActor>();
  for (const g of groups) {
    byId.set(g.person.id, g.person);
    for (const s of g.sessions) {
      for (const p of s.participants) if (!byId.has(p.id)) byId.set(p.id, p);
    }
  }
  return byId;
}

/** The most recent thing in a group, for ordering it. */
export function groupLastAt(g: RailPersonGroup): number {
  let last = 0;
  for (const s of g.sessions) if (s.lastAt > last) last = s.lastAt;
  return last;
}

/** You first, then whoever moved most recently, then alphabetically.
 *
 *  Your own group leads unconditionally — it is the only one you can act in
 *  without joining anything, and burying it under a busy teammate would make
 *  the rail's first row a stranger's. Everyone else sorts by recency because
 *  the question the rail answers is "who is working on what", and someone who
 *  last moved in March is not the answer. Name breaks the tie so a rail of
 *  idle teammates holds still between renders. */
export function sortGroups(groups: RailPersonGroup[]): RailPersonGroup[] {
  return [...groups].sort((a, b) => {
    if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
    const d = groupLastAt(b) - groupLastAt(a);
    if (d !== 0) return d;
    return a.person.name.localeCompare(b.person.name);
  });
}

/** Newest session first, inside a person's group. */
export function sortSessions(sessions: RailSession[]): RailSession[] {
  return [...sessions].sort((a, b) => b.lastAt - a.lastAt);
}

/** Pips in an order that reads: each person, then the agents that are theirs,
 *  then anyone unattached.
 *
 *  Ordering by owner is what makes "two humans and two agents are in here"
 *  legible at 14px — the alternative (wire order) interleaves them and the
 *  pairing has to be inferred from four overlapping discs. */
export function orderPips(participants: RailActor[]): RailActor[] {
  const humans = participants.filter((p) => p.kind === "human");
  const agents = participants.filter((p) => p.kind === "agent");
  const out: RailActor[] = [];
  const placed = new Set<string>();
  for (const h of humans) {
    out.push(h);
    placed.add(h.id);
    for (const a of agents) {
      if (a.ownerId === h.id && !placed.has(a.id)) {
        out.push(a);
        placed.add(a.id);
      }
    }
  }
  for (const a of agents) if (!placed.has(a.id)) out.push(a);
  return out;
}

/** Is anyone actually in this session right now? */
export function isSessionLive(s: RailSession): boolean {
  return s.participants.some((p) => isPresent(p.state));
}

/**
 * Is there anybody here but you?
 *
 * The rail is a collaboration surface, and with nobody to collaborate with it
 * is a list of your own sessions filed under your own name — which the app
 * already shows you in three better places. Worse, it answers a question
 * nobody asked: seeing your own name in a "People" list reads as a bug, because
 * a list of people that contains only the person reading it is not a list of
 * people.
 *
 * Two ways to be worth drawing, and a shared session with nobody in it yet is
 * the second one. The moment you hand out a link you are waiting for someone,
 * and the rail is where you watch them arrive — it must not appear only at the
 * instant they do, or the host never sees the room they opened.
 */
export function railHasCompany(groups: RailPersonGroup[]): boolean {
  return groups.some((g) => !g.isYou || g.sessions.some((s) => s.joined));
}

/** Put the sessions under the people who own them.
 *
 *  Everyone in `people` gets a group, including someone with nothing open —
 *  a teammate who is here but idle is an answer to "who is working on what",
 *  and dropping them would make the rail's population flicker with their
 *  activity. A session whose owner isn't in `people` is dropped rather than
 *  filed under a stranger: the rail's promise is that the name above a row is
 *  whose work it is. */
export function buildGroups(
  people: RailActor[],
  sessions: RailSession[],
  ownerOf: (session: RailSession) => string,
  youId: string,
): RailPersonGroup[] {
  const known = new Set(people.map((p) => p.id));
  const byOwner = new Map<string, RailSession[]>();
  for (const s of sessions) {
    const owner = ownerOf(s);
    if (!known.has(owner)) continue;
    const list = byOwner.get(owner);
    if (list) list.push(s);
    else byOwner.set(owner, [s]);
  }
  return sortGroups(
    people.map((person) => ({
      person,
      isYou: person.id === youId,
      sessions: sortSessions(byOwner.get(person.id) ?? []),
    })),
  );
}
