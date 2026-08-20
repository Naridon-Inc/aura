// Which credential a place pushes with, said out loud before it is spent.
//
// A push from a shared box used to be attributed to whoever provisioned it, and
// nothing on screen said so. `provision.sh` writes one token into
// `~/.git-credentials` for the whole machine, a bare `git clone` inherits it,
// and the first anyone learns whose it was is a commit on GitHub with the wrong
// name against it. The backend fixed the choosing (`manager::brain::place_git`).
// This is the other half: a surface can now ask *before* the push, and say it.
//
// Mirrors `place_git`'s serialized types field for field, so the two cannot
// disagree about what was chosen — and, like `capabilities`, takes a `Place`
// rather than a machine id, because "whose token is about to be spent" is a
// question this laptop has to answer too.

import { api } from "../api";
import type { Place } from "./contract";

/** What a place will push with.
 *
 *  `helper` is the whole mechanism — git's own credential-helper spelling — so
 *  a token in a file, a token in a keychain and a program that mints one on
 *  demand all describe themselves in one field. What this adds is the two facts
 *  git has no opinion about: whose credential it is, and whether it was the
 *  only one left. */
export type GitCredential = {
  /** Which implementation answered — `member-store`, `place-default`, or
   *  whatever is added next. */
  source: string;
  /** What to put on screen before spending it. Written for a person, by the
   *  source that knows what it is. */
  label: string;
  /** The value git is given for `credential.helper`. */
  helper: string;
  /** Where it came from, in the place's own words — a path, or the helper. */
  detail: string;
  host: string;
  /** Is this everybody-on-this-place's rather than this member's? The one fact
   *  a surface must never round off: a shared credential works fine and lands
   *  under somebody else's name. */
  shared: boolean;
  /** Was this only reached because nothing else answered? */
  last_resort: boolean;
};

/** Why this place has no credential for this ask.
 *
 *  Two of these are not failures: an ssh remote pushes with a key and wants no
 *  helper, and a place with nothing configured needs a person to go and set one
 *  up. A surface that rendered all four as "something went wrong" would be
 *  wrong twice. */
export type NoCredential =
  | { gap: "no_member" }
  | { gap: "not_a_remote"; remote: string }
  | { gap: "pushes_with_an_ssh_key"; host: string }
  /** `tried` names the sources that were asked, so the answer doesn't imply
   *  there is only one way to have a credential. */
  | { gap: "none_held"; host: string; tried: string[] };

/** One source, asked.
 *
 *  Not debugging output. When the answer is the shared box credential, the only
 *  useful thing to tell somebody is WHY it was reached — "you have no account
 *  here yet" and "your store has nothing for github.com" lead to two different
 *  next steps, and neither is guessable from the answer alone. */
export type Considered = {
  source: string;
  held: boolean;
  /** Its label when it held one, its reason when it did not. */
  why: string;
  last_resort: boolean;
};

/** What a push from a place would actually spend. */
export type PushPlan = {
  member: string;
  remote: string;
  host: string;
  /** What to call the place in a sentence — "this laptop", or the box's name. */
  place: string;
  /** Null is an ANSWER, with `gap` saying which — not a failure. */
  credential: GitCredential | null;
  gap: NoCredential | null;
  considered: Considered[];
};

/** Ask a place which credential a push would spend, before it is spent.
 *
 *  One function for both place-modes, because it takes a `Place`: a box is
 *  asked over ssh, this laptop answers the same survey about its own git
 *  config, and there is no second spelling to drift.
 *
 *  THROWS only when the place can't be reached. A resolved plan with
 *  `credential: null` is the place's own answer and must be rendered as one. */
export function askPushCredential(
  place: Place,
  remote: string,
  member?: string,
): Promise<PushPlan> {
  return api.placePushCredential(
    { root: place.project.root, machineId: place.machineId },
    remote,
    member,
  );
}

/** How much of a warning this deserves.
 *
 *  `shared` is the one that matters and the only one that is amber: the push
 *  will work, and it will land under somebody else's name. A gap is neutral —
 *  an ssh remote is fine, and an unconfigured place is a thing to go and do,
 *  not a thing that just went wrong. */
export type CredentialTone = "own" | "shared" | "none";

export function credentialTone(plan: PushPlan): CredentialTone {
  if (!plan.credential) return "none";
  return plan.credential.shared ? "shared" : "own";
}

/** The sentence to show before a push or a clone.
 *
 *  One phrasing, so every surface that spends a credential says it the same
 *  way. The subject is always a person's name, because the whole point of the
 *  line is that a push has one. */
export function credentialSentence(plan: PushPlan): string {
  const cred = plan.credential;
  if (cred) {
    return cred.shared
      ? `Pushes as ${cred.label}. Commits will land under it, not under ${plan.member}.`
      : `Pushes with ${cred.label}.`;
  }
  return gapSentence(plan);
}

/** The same thing when there is nothing to spend. Separate because a surface
 *  that only wants to warn — the amber line — needs the gap without the
 *  credential branch. */
export function gapSentence(plan: PushPlan): string {
  const gap = plan.gap;
  if (!gap) return "";
  switch (gap.gap) {
    case "pushes_with_an_ssh_key":
      // Not "nothing here holds one" — there is nothing here that COULD. What a
      // person can act on is whose key it will be, which is why the sentence
      // names the machine rather than the mechanism.
      return `Pushes to ${gap.host} over ssh, and no key of yours is reachable from ${plan.place} — so it uses that machine's own key.`;
    case "not_a_remote":
      return `${gap.remote} isn't a git remote a credential can be found for.`;
    case "no_member":
      return "Nobody is named as the one pushing, so there is no credential to look for.";
    case "none_held":
      return `Nothing on ${plan.place} holds a credential for ${gap.host} — a push will be asked for one.`;
  }
}

/** Why the credential that was chosen is the one that was chosen — the sources
 *  that were asked and declined, in the order they were asked.
 *
 *  Only worth showing when the answer is a shared credential: that is the case
 *  where the person can do something about it, and the reasons are the
 *  instructions for doing it. */
export function whyNotMine(plan: PushPlan): string[] {
  return plan.considered.filter((c) => !c.held).map((c) => c.why);
}
