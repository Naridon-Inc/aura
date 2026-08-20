// What the rail draws, built from what this app actually knows.
//
// The rail's model is person-first: sessions hang under the human whose work
// they are. Nothing else in the app is shaped that way. Every local source —
// `LiveAgentSession`, `ClaudeSession`, `SessionSummary` — is a session with a
// path and a timestamp and no person anywhere on it, because until now there
// was only ever one person. So this file is where the two meet, and it is
// deliberately the only place that reaches across both.
//
// Two rules it holds to:
//
//  - **The rail is company, not inventory.** It builds your group the same as
//    anyone's, but the host decides whether to draw any of it: with nobody else
//    here and nothing shared, there is no rail (`railHasCompany`). An earlier
//    version showed you to yourself so the feature could be found before it was
//    used, and it read as a bug — a list of people containing only the person
//    reading it. Discovery belongs to Share, which lives on the session where
//    the decision to invite is actually made.
//  - **Nobody is invented.** Other people appear because the session plane
//    reported them as participants, never because a session was found on disk
//    and somebody had to be named as its owner. A rail that guesses whose work
//    something is would be worse than no rail.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { api } from "../../../lib/api";
import { avatarSrcForMember } from "../../../lib/memberAvatar";
import { fetchIdentity } from "../../../lib/teamCache";
import { useLiveAgentSessions } from "../../../lib/useLiveAgentSessions";
import {
  getSessionLive,
  liveSessionIds,
  sessionsVersion,
  subscribeSessions,
  type SessionLiveState,
} from "../../../lib/sessionLiveStore";
import type { RailActor, RailPersonGroup, RailSession } from "./railModel";
import { buildGroups } from "./railModel";
import {
  mergePresence,
  railActorsFromParticipants,
  railSessionFromLive,
  type RailSessionMeta,
} from "./railFromLive";

/** The participant id used for you before the plane has given you a real one.
 *  Stable for the life of the app so a group doesn't re-key mid-render. */
const YOU_LOCAL_ID = "you:local";

/** An agent that wrote to its terminal this recently is treated as mid-turn.
 *  Long enough to survive it thinking, short enough that a finished agent stops
 *  claiming to be busy while you watch. */
const BUSY_WINDOW_MS = 30_000;

/** Longest a session title runs in the rail before the row truncates it
 *  anyway. Cutting here keeps an entire first prompt out of the model. */
const TITLE_MAX = 80;

function trimTitle(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= TITLE_MAX) return one;
  return `${one.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * A name for a session, preferring what the person actually saw.
 *
 * The terminal's own title is what they watched being set, so it wins. Failing
 * that, the opening line of the transcript is the closest thing to what the
 * session is *about*. Only when there is neither does this fall back to a
 * label, and the label says what it is rather than pretending to be a subject.
 */
function titleFor(
  localTitle: string | null | undefined,
  live: SessionLiveState | null,
): string {
  if (localTitle && localTitle.trim()) return trimTitle(localTitle);
  const first = live?.entries.find((e) => e.text.trim().length > 0);
  if (first) return trimTitle(first.text);
  return "Shared session";
}

/** Read every live session the store holds, and re-read on every change.
 *
 *  Watches the registry as a whole rather than one session, because the change
 *  that matters most here is a session the rail has never seen appearing. The
 *  version counter is the snapshot; the states are read fresh when it moves. */
function useLiveSessions(): SessionLiveState[] {
  const version = useSyncExternalStore(
    subscribeSessions,
    sessionsVersion,
    sessionsVersion,
  );
  return useMemo(
    () => liveSessionIds().map((id) => getSessionLive(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}

type Me = {
  name: string;
  avatar: string | null;
  /** Null until the first read lands, whichever way it lands. */
  settled: boolean;
};

const UNKNOWN_ME: Me = { name: "You", avatar: null, settled: false };

/**
 * You, drawn from the same identity the rest of the app draws you from.
 *
 * The sidebar footer, the team roster and chat all resolve the signed-in
 * person through `fetchIdentity` — per-repo override, then roster alias, then
 * git. A rail that read a different source would put a second name for the
 * same human on the same screen, which is exactly the confusion this rail is
 * supposed to remove. `fetchIdentity` is shared and windowed, so asking here
 * costs nothing the footer wasn't already paying.
 *
 * `cloudAuthStatus` is the fallback rather than the source: it knows an
 * account, not a person in this repo, and it is the only thing left when the
 * repo has no roster at all.
 */
function useMe(repoRoot: string | null | undefined): Me {
  const [me, setMe] = useState<Me>(UNKNOWN_ME);
  useEffect(() => {
    let alive = true;
    const settle = (next: Omit<Me, "settled">) => {
      if (alive) setMe({ ...next, settled: true });
    };
    if (!repoRoot) {
      // No project open. There is still a you, and the rail still draws you.
      api
        .cloudAuthStatus()
        .then((s) => settle({ name: s.user?.trim() || "You", avatar: null }))
        .catch(() => settle({ name: "You", avatar: null }));
      return () => {
        alive = false;
      };
    }
    Promise.all([
      fetchIdentity(repoRoot),
      // A photo you picked yourself outranks GitHub's. Missing is ordinary —
      // the avatar falls through to the monogram either way.
      api.identityAvatarsGet().catch(() => ({}) as Record<string, string>),
    ])
      .then(([ident, avatars]) => {
        const name =
          ident.effective_name?.trim() ||
          ident.name?.trim() ||
          atHandle(ident.effective_handle ?? ident.handle) ||
          "You";
        settle({
          name,
          avatar: avatarSrcForMember(
            { email: ident.email, github_login: ident.account_login },
            avatars,
            44,
          ),
        });
      })
      .catch(() => {
        api
          .cloudAuthStatus()
          .then((s) => settle({ name: s.user?.trim() || "You", avatar: null }))
          .catch(() => settle({ name: "You", avatar: null }));
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return me;
}

/** `mhask` → `@mhask`, and nothing → nothing. */
function atHandle(handle: string | null | undefined): string {
  const h = handle?.trim().replace(/^@+/, "") ?? "";
  return h ? `@${h}` : "";
}

export type RailGroupsResult = {
  /** `null` until the first read completes — the rail draws that differently
   *  from an answered-and-empty list, so the two must not collapse. */
  groups: RailPersonGroup[] | null;
  loading: boolean;
  error: string | null;
};

/**
 * The rail's contents.
 *
 * `nowMs` exists for the screenshot harness, which pins the clock so relative
 * ages don't drift between shots. The app leaves it off.
 */
export function useRailGroups(
  repoRoot?: string | null,
  nowMs?: number,
): RailGroupsResult {
  const localSessions = useLiveAgentSessions(true);
  const liveSessions = useLiveSessions();
  const me = useMe(repoRoot);

  // What "still loading" honestly means here: we don't yet know who YOU are.
  // Everything else the rail draws is additive — sessions arrive on a poll,
  // people arrive as they join — and a rail that withheld itself until every
  // source had answered would spin forever on a machine where nothing is
  // running, which is a normal machine.
  //
  // The identity read is the one thing it genuinely cannot draw without: the
  // rail is grouped by person and you are always the first group.
  const settled = me.settled;

  return useMemo(() => {
    const now = nowMs ?? Date.now();

    // Your participant id, once the plane has given you one. Every session you
    // are in agrees on it, so the first that has it wins; before that the rail
    // uses a local id and nothing breaks when the real one arrives.
    const youId =
      liveSessions.find((s) => s.you !== null)?.you?.id ?? YOU_LOCAL_ID;

    const you: RailActor = {
      id: youId,
      name: me.name,
      kind: "human",
      avatar: me.avatar,
      state: "idle",
    };

    // Which external sessions are backed by an agent running here. Used both to
    // give a live session its title and to keep the same session from appearing
    // twice — once as your local agent and once as a shared row.
    const hostedLocalIds = new Set(
      liveSessions
        .map((s) => s.agentSessionId)
        .filter((id): id is string => id !== null),
    );

    const sessions: RailSession[] = [];
    const ownerOf = new Map<string, string>();
    const seenActors: RailActor[] = [];

    // 1. Sessions on the plane — the only ones that can belong to someone else.
    for (const live of liveSessions) {
      const local = live.agentSessionId
        ? localSessions.find((l) => l.session_id === live.agentSessionId)
        : undefined;
      const actors = railActorsFromParticipants(live.participants);
      seenActors.push(...actors);

      // Whose session is it: yours if this desktop holds the host role,
      // otherwise the participant the server marked host. A session with no
      // host present is dropped by `buildGroups` rather than filed under a
      // guess.
      const hostParticipant = live.participants.find((p) => p.role === "host");
      const owner =
        live.role === "host"
          ? youId
          : hostParticipant
            ? hostParticipant.id
            : youId;
      ownerOf.set(live.sessionId, owner);

      const meta: RailSessionMeta = {
        id: live.sessionId,
        title: titleFor(local?.title, live),
        ownerId: owner,
        lastAt: local ? Math.floor(local.last_byte_ms / 1000) : 0,
        agentBusy: local ? now - local.last_byte_ms < BUSY_WINDOW_MS : false,
      };
      sessions.push(railSessionFromLive(meta, live));
    }

    // 2. Your own agents that nobody is sharing. These are the ordinary case
    //    today, and they are real rows: a title, an age, and whether the agent
    //    is mid-turn. They are not "resting" in the plane's sense — the machine
    //    that runs them is this one, and it is plainly online — so `hostOnline`
    //    is true rather than borrowed from a socket that was never opened.
    for (const l of localSessions) {
      if (hostedLocalIds.has(l.session_id)) continue;
      ownerOf.set(l.session_id, youId);
      sessions.push({
        id: l.session_id,
        title: titleFor(l.title, null),
        participants: [],
        lastActorId: null,
        lastAt: Math.floor(l.last_byte_ms / 1000),
        activity: [],
        joined: false,
        access: null,
        hostOnline: true,
        agentBusy: now - l.last_byte_ms < BUSY_WINDOW_MS,
      });
    }

    // Everyone the plane has actually reported, plus you. Agents are not people
    // and never head a group — they show up as pips inside their owner's rows.
    const peopleById = new Map<string, RailActor>();
    peopleById.set(you.id, mergePresence(you, seenActors));
    for (const a of seenActors) {
      if (a.kind !== "human" || a.id === you.id) continue;
      if (!peopleById.has(a.id)) {
        peopleById.set(a.id, mergePresence(a, seenActors));
      }
    }

    const groups = buildGroups(
      [...peopleById.values()],
      sessions,
      (s) => ownerOf.get(s.id) ?? youId,
      youId,
    );

    return {
      groups: settled ? groups : null,
      loading: !settled,
      error: null,
    };
  }, [liveSessions, localSessions, me.name, me.avatar, nowMs, settled]);
}
