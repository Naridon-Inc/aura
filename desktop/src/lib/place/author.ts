// Whose name ends up on the commit, said out loud before it is made.
//
// `pushCredential` settles whose TOKEN carries the push. This settles whose NAME
// is written into the commit object first, and they are genuinely different
// failures — a push with the right credential and the wrong author lands in the
// right account with somebody else's name in `git log`, permanently, and no
// later credential fix reaches back into history.
//
// The frontend already derived the identity: `accountIdentity.ts` turns a
// signed-in Aura account into a `GitAuthor`. What it could not do is get it
// anywhere but this laptop — `gitIdentitySet` wrote repo-local git config in a
// local directory, so the moment work moved to a box the identity stayed behind
// and the commit came back authored by whoever the box thought it was. On a
// runner box that was a hardcoded `Aura Runner <runner@auravcs.com>`.
//
// So this takes a `Place` rather than a repo root, mirrors
// `manager::brain::place_author` field for field, and reuses `GitAuthor` instead
// of restating it — a second spelling of an author is a second thing that can
// disagree about who somebody is.

import { api } from "../api";
import type { GitAuthor } from "../accountIdentity";
import type { Place } from "./contract";

export type { GitAuthor } from "../accountIdentity";

/** Whose name a commit made at a place right now would carry.
 *
 *  Four cases, not two, because they lead four different places. A commit
 *  authored by the box is not "no author" — it succeeds, quietly, and the audit
 *  trail loses the person. A commit authored by a *colleague* is the one case
 *  where overwriting unasked would be the wrong move. */
export type Authorship =
  /** The member's own. Nothing to do. */
  | { who: "mine"; author: GitAuthor }
  /** The machine's, or one git invented from the login and the hostname.
   *  `why` is what gave it away. */
  | { who: "machine"; author: GitAuthor; why: string }
  /** A real person's, and not this member's. */
  | { who: "someone"; author: GitAuthor }
  /** Git has nothing to author with here. */
  | { who: "missing"; why: string };

/** What a commit from a place would be authored as. */
export type AuthorPlan = {
  /** What to call the place in a sentence — "this laptop", or the box's name. */
  place: string;
  root: string;
  /** The login the place answered as. Not the author: on a shared box the
   *  session may be `ubuntu` while the commit is correctly the member's. */
  you: string;
  /** What the signed-in account offers, when anything is signed in. */
  member: GitAuthor | null;
  authorship: Authorship;
  /** Which file the current identity came from, in git's own `--show-origin`
   *  spelling. Empty means no file did — git would invent one. */
  origin: string;
  /** Did the call that produced this plan write the identity? */
  adopted: boolean;
  /** The one sentence to show. Written by the backend so every surface says it
   *  the same way. */
  note: string;
};

/** Ask a place whose name a commit from it would carry.
 *
 *  One function for both place-modes, because it takes a `Place`: a box is asked
 *  over ssh, this laptop answers about its own checkout, and there is no second
 *  spelling to drift. `member` is the account's derived identity — pass it and
 *  the answer can say whether the current author is *yours*; omit it and the
 *  answer is still honest, it just cannot.
 *
 *  THROWS only when the place can't be reached. An `authorship` of `missing` is
 *  the place's own answer and must be rendered as one. */
export function askAuthor(
  place: Place,
  member?: GitAuthor | null,
): Promise<AuthorPlan> {
  return api.placeAuthor(
    { root: place.project.root, machineId: place.machineId },
    member ?? null,
  );
}

/** Write the account's identity onto the checkout at a place, wherever it is.
 *
 *  Repo-LOCAL on both sides of the wire — never `--global`, because a place may
 *  be a box a team shares and a global write there changes who *they* are too.
 *
 *  Idempotent: running it against a checkout that already carries the identity
 *  is how a member verifies their name is the one on their commits. */
export function adoptAuthor(
  place: Place,
  author: GitAuthor,
): Promise<AuthorPlan> {
  return api.placeAuthorAdopt(
    { root: place.project.root, machineId: place.machineId },
    author,
  );
}

/** How much of a warning this deserves.
 *
 *  `machine` is the amber one and the reason this module exists: the commit will
 *  succeed and it will carry the box's name. `someone` is amber too but for the
 *  opposite reason — it is a real person, so the fix is to ask rather than to
 *  overwrite. */
export type AuthorTone = "own" | "machine" | "someone" | "none";

export function authorTone(plan: AuthorPlan): AuthorTone {
  switch (plan.authorship.who) {
    case "mine":
      return "own";
    case "machine":
      return "machine";
    case "someone":
      return "someone";
    case "missing":
      return "none";
  }
}

/** Is there anything for a member to do here?
 *
 *  False when the commit would already carry their name — which is what lets a
 *  surface stay quiet instead of offering a button that changes nothing. */
export function needsAdopting(plan: AuthorPlan): boolean {
  return plan.authorship.who !== "mine" && plan.member !== null;
}

/** The author a commit would currently carry, whoever's it is. */
export function currentAuthor(plan: AuthorPlan): GitAuthor | null {
  const a = plan.authorship;
  return a.who === "missing" ? null : a.author;
}

/** `Name <email>`, the way git renders it. */
export function authorLine(author: GitAuthor): string {
  return `${author.name} <${author.email}>`;
}

/** Why the current author is not the member's own — the reason, not the state.
 *
 *  Empty when it already is theirs. Only worth showing for the two cases a
 *  person can act on, because "this is the machine's identity, set in
 *  /etc/gitconfig" and "this is Ana" lead to two different next steps and
 *  neither is guessable from the author alone. */
export function whyNotMe(plan: AuthorPlan): string {
  const a = plan.authorship;
  switch (a.who) {
    case "mine":
      return "";
    case "machine":
      return a.why;
    case "someone":
      return `${authorLine(a.author)} is set for this project, and that is somebody else.`;
    case "missing":
      return a.why;
  }
}
