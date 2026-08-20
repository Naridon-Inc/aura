// One type for a place, because there is one contract for a place.
//
// The backend collapsed every way of reaching a machine onto `Place` — open,
// capabilities, sessions, identity, lifecycle, meter — for one reason: a
// surface that reached a box in its own words was a surface where a second way
// of *getting* a machine could quietly have fewer features than the first, and
// nobody would find out until a user did.
//
// The frontend had the same shape of problem in miniature, spread across four
// half-spellings that never referred to each other. `remoteAgents` knew what a
// box could run. `machinePlacement` knew where a box belonged and what to call
// its row. The rail held a `Machine`. The panel held a bare `machineId` string.
// Nothing in any of them said these were the same subject, so each could learn
// something the others didn't — and none of them could be asked about this
// laptop at all, because every one of them was written in the shape of a box.
//
// This is the whole spelling. `Machine` stays exactly what it is: the book's
// row — an address, a login, a key path, the facts we hold without asking
// anyone. A `Place` is what that row *means*: somewhere work runs, whether you
// dial it or not. Mirrors `manager::brain::place_contract`, field for field, so
// the two cannot disagree about what a place is.

import type { Machine } from "../api";

/** `here` is this laptop. The rest are the ways you can come to have a box:
 *  one you brought, one you share with your team, one Aura runs for you.
 *
 *  The distinction is for billing and for who holds root. It is never for which
 *  features a place gets — nothing in this module may branch on it, and the
 *  moment something does, that is a feature living in one place-mode only. */
export type PlaceKind = "here" | "mine" | "shared" | "managed";

/** What a place can actually run, read off the place rather than assumed.
 *
 *  Mirrors `place_contract::Capabilities`. Note what is NOT here: a "we asked
 *  and it didn't answer" case. That absence is spelled `null` wherever this
 *  type is held, because an empty `agents` is a place's answer about itself and
 *  a missing one is our failure to get an answer — see `Place.capabilities`. */
export type PlaceCapabilities = {
  /** The subset of the candidate binaries that are present, in the order
   *  asked. Empty means the place genuinely has none of them. */
  agents: string[];
  git: boolean;
  /** Without tmux nothing here outlives its connection: no durable sessions,
   *  no attaching, no coming back tomorrow. */
  tmux: boolean;
  /** A box is allowed to have never heard of Aura. This says whether it has. */
  aura: boolean;
};

/** Who the work runs as, and where that is.
 *
 *  Deliberately says nothing about this laptop's host or address: a local place
 *  has neither, and inventing a plausible one ("localhost") leaves a value some
 *  later surface tries to ssh to. */
export type PlaceIdentity = {
  /** The login the work runs under. */
  user: string;
  /** The host it runs on, when the place is somewhere you dial. */
  host: string | null;
  /** Where the private key lives ON THIS LAPTOP — a path, never key material,
   *  and null when no key is involved. */
  key_path: string | null;
  kind: PlaceKind;
  /** The book's key for this place, for a surface that needs to name it back
   *  to the machine book. */
  address: string | null;
  /** Is this place allowed to use the ssh key on this laptop while it is
   *  connected?
   *
   *  A fact about WHOSE key the work runs with, which is why it sits beside
   *  `key_path` rather than in a settings object somewhere: those two answer
   *  the same question from the two ends. `false` for this laptop is not a
   *  missing feature — work here already runs beside your agent. */
  forward_agent: boolean;
};

/** Which project this place holds, in the three terms three surfaces need.
 *
 *  They are three different questions and were three different fields on the
 *  machine row for good reason: `root` is a path on THIS disk and means nothing
 *  over there, `path` is a path over there and means nothing here, and `branch`
 *  is what is checked out in it. Collapsing any two would file a box under a
 *  repo it has never seen. */
export type PlaceProject = {
  /** The LOCAL repo root this place is a copy of — the same key the roster
   *  files a project under, so the place can sit with that project's own copies
   *  instead of in a group of strangers. Null until something says; a guess
   *  here is worse than an absence, and the rail already handles absence. */
  root: string | null;
  /** Where the project sits ON the place. */
  path: string | null;
  /** What is checked out in `path`, last time anything looked. Null before
   *  anything has been there, or when the checkout has no branch to name. */
  branch: string | null;
};

/** Somewhere work runs.
 *
 *  This laptop is one. A box you brought is one. An Aura-managed VM will be one
 *  without this type learning a new case — which is the entire point of there
 *  being one type. */
export type Place = {
  /** The machine book's key — `user@host:/repo`. `null` is this laptop, which
   *  has no address to dial and must never be given a plausible one. Every call
   *  that reaches a place takes this, so the local arm is expressible in the
   *  same words as the remote one rather than being a different function. */
  machineId: string | null;
  /** What to call it. Never printed as the address — see `placeRowLabel`. */
  name: string;
  identity: PlaceIdentity;
  project: PlaceProject;
  /** Unix seconds from the machine book: when it was added, and when you were
   *  last on it. The two facts about a place that cost nothing to know, which
   *  is why the rail can draw an age without reaching anything. */
  addedAt: number;
  lastUsedAt: number;
  /** Unix seconds since Aura put this place to sleep to stop it costing, or `0`
   *  while it is up.
   *
   *  On the place rather than on a status object somewhere, because every
   *  surface that draws a place has to read it BEFORE it concludes anything from
   *  a failed connection. A sleeping machine refuses connections exactly the way
   *  a broken one does, so the difference cannot be discovered by asking — it
   *  can only be known from the row. `isAsleep` is the one spelling; nothing
   *  should compare this to zero itself. */
  asleepSince: number;
  /** The handle Aura may name when it stops or starts this place, or `null` for
   *  one nobody gave Aura a way to switch off.
   *
   *  Two shapes, and the difference is written in the value rather than in a
   *  second field. A bare handle belongs to a machine Aura made in its own
   *  account. A qualified one — `grant:<account>/<machine>` — belongs to a box
   *  the customer owns, in a cloud account they granted Aura a narrow role in,
   *  and it says which account because the stop is signed by that role rather
   *  than by Aura's own credential. `isGrantedHandle` is the one reading; see
   *  `./grant`.
   *
   *  Here so that "may Aura switch this off" is answerable from the row alone,
   *  which is what lets a rail of forty places draw forty Sleep buttons without
   *  reaching anything. Never a credential and never an address — a name the
   *  cloud gave the machine, useless to anybody who cannot already sign
   *  requests against the account holding it. */
  lifecycleHandle: string | null;
  /** What this place can run — `null` when nobody has asked yet, the probe
   *  failed, or the place couldn't be reached.
   *
   *  THE RULE THIS TYPE EXISTS TO CARRY: `null` is not `{agents: []}`. "We
   *  don't know" is not "it has none". A picker that renders them the same way
   *  shows an empty list to someone whose box is merely slow to answer, and the
   *  only thing they can conclude is that their machine is broken. See
   *  `offerableAgents`, which is the one place that decision is made. */
  capabilities: PlaceCapabilities | null;
};

/** A machine book row, read as the place it describes.
 *
 *  Nothing is invented on the way: every field either comes off the row or is
 *  the honest `null`. `capabilities` in particular starts life unknown, because
 *  the book has never asked the box anything — it holds an address, not a
 *  survey. */
export function placeOfMachine(
  m: Machine,
  capabilities: PlaceCapabilities | null = null,
): Place {
  return {
    machineId: m.id,
    name: m.name,
    identity: {
      user: m.user,
      host: m.host,
      key_path: m.key_path,
      kind: placeKindOf(m.box_kind),
      address: m.id,
      // Absent means off. A book written before the field existed holds no
      // decision, and reading no decision as consent is the one way this could
      // go wrong quietly.
      forward_agent: m.forward_agent === true,
    },
    project: {
      root: blankToNull(m.project_root),
      path: blankToNull(m.repo_path),
      branch: blankToNull(m.repo_branch),
    },
    addedAt: m.added_at,
    lastUsedAt: m.last_used_at,
    // Absent means awake. A book written before the field existed holds rows
    // for machines that were never slept, and reading a missing field as a
    // timestamp would put every one of them to sleep on screen.
    asleepSince: m.asleep_since ?? 0,
    // Absent means nobody gave Aura a way to switch this machine off, which is
    // the state of every row anybody brought and of every book written before
    // the field existed.
    lifecycleHandle: blankToNull(m.instance_id),
    capabilities,
  };
}

/** The machine book, read as places. Order is the book's order — most recently
 *  used first — and stays that way, because that order is the answer to "which
 *  one did you mean". */
export function placesOfMachines(machines: readonly Machine[]): Place[] {
  return machines.map((m) => placeOfMachine(m));
}

/** This laptop, as a place.
 *
 *  Not decoration. Every call in this module takes a `Place`, and without a way
 *  to name the local one, each of those calls would be a box-only call wearing
 *  a general name — which is precisely the failure the seam exists to prevent.
 *  It has no address and no key, and it says so rather than inventing either. */
export function placeHere(root: string | null, name = "This computer"): Place {
  return {
    machineId: null,
    name,
    identity: {
      user: "",
      host: null,
      key_path: null,
      kind: "here",
      address: null,
      forward_agent: false,
    },
    project: { root: blankToNull(root), path: blankToNull(root), branch: null },
    addedAt: 0,
    lastUsedAt: 0,
    // The computer you are looking at is not asleep, and Aura does not switch
    // it off. Zero here is a fact about this place, not a default — and there is
    // no cloud account anybody could grant a role in that would change it.
    asleepSince: 0,
    lifecycleHandle: null,
    capabilities: null,
  };
}

/** The address every `box_*` verb needs, or `""` for this laptop — which those
 *  verbs reject, and rightly: there is no session on a box that has no address.
 *  Spelled once here so no caller reaches for its own `?? ""`. */
export function placeAddress(place: Place): string {
  return place.machineId ?? "";
}

/** A book row's `box_kind`, narrowed.
 *
 *  A row written before a kind existed, or holding one this build has never
 *  heard of, reads as a box you brought rather than being dropped — the address
 *  in that row is the only way back to that machine, and a place we can't
 *  classify is still a place you can open. */
function placeKindOf(boxKind: string): PlaceKind {
  const k = boxKind.trim();
  return k === "shared" || k === "managed" || k === "here" ? k : "mine";
}

/** Blank is not an answer. The book has rows whose fields are whitespace — a
 *  hand-edited entry, a wizard step someone tabbed past — and `"   "` filed as
 *  a project root is a place filed under a repo named nothing. */
function blankToNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}
