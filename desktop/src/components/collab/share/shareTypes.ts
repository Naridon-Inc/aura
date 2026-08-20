// The vocabulary the share / join / tunnel surfaces speak.
//
// Everything the wire protocol already names lives in `lib/sessionLive` and is
// RE-EXPORTED from here, never re-declared — two definitions of `Participant`
// would drift the day the protocol gained a field, and the surface that drifted
// would be whichever one nobody was looking at.
//
// What IS declared here is the handful of things the protocol has no word for
// yet, and which the person using this product very much does:
//
//   • ACCESS LEVEL. `docs/collab/SESSION_LIVE_PROTOCOL.md` knows two roles —
//     host and guest — and a guest may emit `msg`, `typing` and `cursor` with
//     no way to say "watch, but don't touch". The product needs that
//     distinction, so it is modelled here and carried alongside the
//     participant list. See the note on `AccessLevel` for what the server
//     still has to grow.
//   • THE THINGS A PERSON TYPES OR CLICKS to get in — a short code and a link.
//     The protocol addresses a session by `external_id` and stops there.
//
// Each of those is flagged in the surrounding comments so nobody mistakes a
// product-side invention for something the wire already guarantees.
//
// A tunnel is NOT declared here: `SessionTunnel` in `lib/sessionLive` is the
// one shape, and the surfaces below render it directly. Who can reach a tunnel
// is not a field on it either, and shouldn't be — a tunnel is reachable by
// exactly the people in the session that opened it, so the answer is the
// roster, and storing a second copy of the roster on each tunnel is how the two
// get to disagree.

import type { Participant, SessionTunnel } from "../../../lib/sessionLive";

export type { Participant, SessionTunnel };

/**
 * What a person in a shared session is allowed to do.
 *
 * - `watch` — they read the transcript as it streams. Their composer is off.
 *   No message of theirs reaches the room, and no agent is ever instructed by
 *   them.
 * - `drive` — they may send messages and instruct agents, exactly as the host
 *   can. In protocol terms: their `msg` frames are accepted and delivered by
 *   the ordinary rule.
 *
 * ⚠ THIS IS NOT YET ENFORCED ON THE WIRE. The protocol as written accepts
 * `msg` from any authenticated guest. Until the server drops `msg` frames from
 * a `watch` participant, this level is an honest UI contract and a dishonest
 * security boundary — so it is presented to people as "what you can do here",
 * never as "nobody can make you do otherwise".
 */
export type AccessLevel = "watch" | "drive";

/** Plain-language wording for each level. One place, because the host's list,
 *  the guest's banner and the share summary all have to agree — the moment two
 *  of them describe "watch" differently, the guest with a dead composer starts
 *  reading the difference as a bug in the app. */
export const ACCESS_META: Record<
  AccessLevel,
  {
    /** How the level is named in a menu or on a row. */
    label: string;
    /** The one-word state, for a chip beside a name. */
    short: string;
    /** What it means, told to the HOST about someone else. */
    hostBlurb: string;
    /** What it means, told to the GUEST about themselves. */
    guestBlurb: string;
  }
> = {
  watch: {
    label: "Can watch",
    short: "Watching",
    hostBlurb:
      "Follows along as the work happens. Can't type here, and can't tell your agents to do anything.",
    guestBlurb:
      "You can follow everything happening here. Sending messages is switched off until the host hands you the wheel.",
  },
  drive: {
    label: "Can drive",
    short: "Driving",
    hostBlurb:
      "Can send messages and give your agents instructions. The same as you can.",
    guestBlurb:
      "You can send messages and give the agents instructions, the same as the person whose machine this is.",
  },
};

export const ACCESS_LEVELS: AccessLevel[] = ["watch", "drive"];

/**
 * A session that has been opened up to teammates.
 *
 * `link` and `code` are product-side; the protocol addresses a session by
 * `externalId` alone and has no minting endpoint for either. Both are treated
 * as ROUTING, never as permission — see `repoName`.
 */
export type SharedSession = {
  /** The same identifier `/sync/sessions` and the live socket already use. */
  externalId: string;
  /** What this session is about, in the words already on the session row. */
  title: string;
  /** The machine the agents actually run on. A guest's instructions land here
   *  and nowhere else, which is why it is stated out loud before anyone joins. */
  hostMachine: string;
  /** The person whose machine it is. */
  hostName: string;
  /** What the server actually gates on: this session's repo. Everyone who
   *  works on it can join; nobody else can, link or no link. Named for the
   *  repo rather than a team or an org because that is the check — the cloud
   *  refuses a joiner with "not a member of this repo", and a sentence that
   *  named some other group would be describing a boundary that isn't there. */
  repoName: string;
  /** The link a teammate opens. */
  link: string;
  /** The short code a teammate can type instead of opening the link. */
  code: string;
  /** What a teammate gets the moment they arrive, before the host changes it. */
  defaultAccess: AccessLevel;
  /** Everyone currently in, humans and agents alike. */
  participants: Participant[];
  /** Level per participant id. Kept beside the list rather than on it because
   *  `Participant` is the protocol's shape and this field is not in it. */
  access: Record<string, AccessLevel>;
};

/** The level for a participant, defaulting the way the server would. */
export function accessFor(
  session: Pick<SharedSession, "access" | "defaultAccess">,
  participantId: string,
): AccessLevel {
  return session.access[participantId] ?? session.defaultAccess;
}

/** Who can reach a tunnel, in words, derived from the roster it belongs to.
 *
 *  Agents are left out on purpose: "Claude can open your dev site" is true and
 *  useless, and padding the line with it buries the name the host is actually
 *  scanning for. */
export function tunnelReach(participants: Participant[]): string[] {
  return participants.filter((p) => p.kind === "human").map((p) => p.name);
}

/** The `aura://localhost:3000` form — the only way a port is written in this
 *  product. It resolves through the relay to `/t/{code}/`; that URL is
 *  plumbing and is never the thing a person is asked to read or share. */
export function auraDisplayUrl(port: number): string {
  return `aura://localhost:${port}`;
}

/** Pull the port back out of a display URL. `null` when the text isn't one. */
export function parseAuraUrl(text: string): { port: number; host: string } | null {
  const m = /^aura:\/\/([a-z0-9._-]+):(\d{1,5})\/?$/i.exec(text.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, host: m[1] };
}

/** Every `aura://host:port` in a blob of text, with its exact bounds, in order.
 *  Used by the composer to swap them for chips without touching the rest. */
export function findAuraUrls(
  text: string,
): Array<{ start: number; end: number; raw: string; port: number; host: string }> {
  const out: Array<{ start: number; end: number; raw: string; port: number; host: string }> = [];
  const re = /aura:\/\/([a-z0-9._-]+):(\d{1,5})\/?/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      port,
      host: m[1],
    });
  }
  return out;
}

/** What you see before you commit to joining. Assembled by the caller from the
 *  `ready` + `presence` frames; nothing here is guessed. */
export type JoinPreview = {
  externalId: string;
  title: string;
  hostName: string;
  hostMachine: string;
  /** The repo the session belongs to, when we know it. A guest looking up a
   *  code usually does NOT: the preview endpoint returns whose machine it is
   *  and who is in there, and says nothing about the repo. Omitted rather than
   *  filled in with the repo the guest happens to have open, which would name
   *  the wrong project with total confidence. */
  repoName?: string;
  /** From `{"type":"host","online":…}`. Offline is a caution, NOT a refusal:
   *  the protocol keeps the session open and persists turns until the host
   *  comes back. */
  hostOnline: boolean;
  participants: Participant[];
  /** What you'll be able to do the moment you're in. */
  yourAccess: AccessLevel;
};

/** The ways getting in can fail, as causes rather than status codes. */
export type JoinFailureKind = "not-found" | "ended" | "not-a-member" | "unknown";

export type JoinFailure = {
  kind: JoinFailureKind;
  /** Extra detail the caller knows — an org name, the server's own sentence.
   *  Shown only where the copy below has a slot for it. */
  detail?: string;
};

/** Plain language for a failure, plus whether trying again could possibly help.
 *  A wrong code is worth retyping; being outside the team is not, and offering
 *  "try again" there just wastes someone's afternoon. */
export function joinFailureCopy(failure: JoinFailure): {
  title: string;
  body: string;
  retryable: boolean;
} {
  switch (failure.kind) {
    case "not-found":
      return {
        title: "That code doesn't match anything",
        body: "Check it against what your teammate sent. Codes are six characters, and they expire when the session is closed.",
        retryable: true,
      };
    case "ended":
      return {
        title: "This session is over",
        body: "The person running it has closed it. Ask them to open it again and send you a fresh link.",
        retryable: false,
      };
    case "not-a-member":
      return {
        title: "You're not in this team",
        body: failure.detail
          ? `This session belongs to ${failure.detail}, and you're signed in with an account that isn't a member. Having the link doesn't get you in. Ask someone in ${failure.detail} to add you first.`
          : "This session belongs to a team you're not a member of. Having the link doesn't get you in. Ask someone on that team to add you first.",
        retryable: false,
      };
    default:
      return {
        title: "That didn't work",
        body:
          failure.detail?.trim() ||
          "Something went wrong reaching the session. Check your connection and try again.",
        retryable: true,
      };
  }
}
