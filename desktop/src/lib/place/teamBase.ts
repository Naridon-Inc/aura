// The team's environment, built once, and each member started from it.
//
// The bill nobody wrote down. `placeMemberAccount` gives every member of a
// shared place their own Unix account, and the toolchain block points every tool
// that keeps state at that account's own home — their crate cache, their rustup,
// their npm prefix. That is the right answer to "whose `npm install -g` was
// that", and its cost is that those directories start EMPTY. The first member
// joins a box and brings it to the project's declared spec: a toolchain, a
// thousand crates, an eleven-minute `cargo install`. The second member joins the
// same box and does the whole thing again, on the same machine, over the same
// network, for the same bytes.
//
// So there is a third account on a shared place that belongs to nobody. The spec
// is applied once in its home, and a member joining starts from a copy of what
// it holds. The first member pays the install; the second pays a file copy.
//
// What crosses is downloads. What never crosses is anybody's credential — keys,
// `gh` and cloud sign-ins, the name on a commit, an agent CLI's session, a
// registry token — which is the whole reason the private home still exists. A
// base found holding one is refused, out loud, naming the file, rather than
// copied.
//
// Mirrors `manager::brain::place_base` and takes a `Place` where the backend
// does, so a warm start cannot be arranged for one way of getting a place and
// not the other. The shell is deliberately NOT spelled here: what a base holds
// and what it must never hold is one table in the backend, and a second opinion
// on this side would agree with it right up until the first fix.

import { api } from "../api";
import type { Place } from "./contract";
import type { DriftTrust } from "./drift";

/** One thing a home holds, with the sentence that goes with it.
 *
 *  The path travels alongside the words rather than being turned into them at
 *  the last moment: a screen shows the sentence, a bug report needs the path.
 *  Both are empty for something the machine had that Aura's own table has never
 *  heard of — reported anyway, because dropping it would be the app hiding what
 *  it found. */
export type Held = {
  /** Relative to a home, e.g. `.cargo`. */
  under: string;
  /** Whose it is: `cargo`, `rustup`, `npm`. */
  tool: string;
  /** What it holds, in words a person reads. */
  holds: string;
};

/** Where the team's already-built environment lives on a place.
 *
 *  Every field is what the machine said, not what was asked for. */
export type TeamBase = {
  /** The place, in the words a person calls it. */
  place: string;
  /** The account it is built in — one that belongs to nobody, so that what it
   *  holds can belong to everybody. */
  login: string;
  home: string;
  /** Did this call create it? */
  created: boolean;
  /** Is it shared — an account of its own that members start from — or simply
   *  the one member's own environment, because there is one member? */
  shared: boolean;
  /** Can the members actually read it? A base nobody can read is a base nobody
   *  starts from, and it would fail one member at a time. */
  readable: boolean;
  /** Does it install into its own directories rather than the machine's?
   *  Without this it comes up empty however many times the spec is applied. */
  scoped: boolean;
  /** What it already holds. */
  holds: Held[];
  /** Anything of one person's, found in a place meant to be everyone's. Must be
   *  empty; anything here stops a member being started from it. */
  carries: string[];
  /** The `[env] version` it was last built to. Zero means never. */
  built_version: number;
  /** The digest of the spec it was last built from, so "already built" is a
   *  fact about a particular spec rather than about a directory existing. */
  built_digest: string;
};

/** What one member started from. */
export type WarmStart = {
  member: string;
  home: string;
  /** The account it came out of. */
  from: string;
  /** Is this member the base? True on a place with one member, where there is
   *  nothing to copy and nothing missing. */
  alone: boolean;
  /** What came across. */
  seeded: Held[];
  /** What the member already had, and kept. Never overwritten — a member who
   *  pinned their own toolchain keeps it. */
  kept: string[];
  /** What the base did not have to give. */
  missing: string[];
  /** What was tried and did not copy — a full disk, a permission. Said out loud
   *  rather than swallowed: the member is about to find out the slow way. */
  failed: string[];
  /** Why nothing came across, when nothing did. Empty otherwise. */
  refused: string;
  /** Did this member start from work somebody else already paid for? */
  warm: boolean;
};

/** How far one declared step got. `already_at_spec` and `brought` both mean the
 *  place is as the project asked; `unsatisfied` means the spec said WHAT without
 *  saying HOW, and `failed` means a command ran and did not do it. */
export type EnvStepState =
  | "already_at_spec"
  | "brought"
  | "unsatisfied"
  | "failed";

/** One thing the project declared, and what became of it. */
export type EnvStep = {
  id: string;
  title: string;
  /** `preflight` | `toolchain` | `package` | `deps` | `service`. */
  kind: string;
  state: EnvStepState;
  /** Exit code of the command that decided it; 0 when nothing ran. */
  code: number;
  /** What the failing command said, trimmed. Empty on success. */
  detail: string;
};

/** What happened when a place was brought to a spec. Mirrors
 *  `aura_env::EnvReport`. */
export type EnvReport = {
  schema: string;
  /** The `[env] version` the place was brought to. */
  version: number;
  digest: string;
  /** Whether the spec that was applied is one anyone should have trusted — the
   *  same tagged shape `drift` reports, because it is the same verdict about the
   *  same seal. */
  trust: DriftTrust;
  steps: EnvStep[];
  /** Every step met. */
  at_spec: boolean;
  /** Something on this place actually changed. */
  changed: boolean;
};

/** The team's environment and what it cost this member to join it. */
export type BaseBuild = {
  base: TeamBase;
  /** Was the base already at this spec, so this call installed nothing?
   *
   *  The claim the whole feature is judged on: false for the first member
   *  through, true for the second. */
  already_built: boolean;
  /** What bringing the base to spec did. `null` when nothing had to run. */
  report: EnvReport | null;
  start: WarmStart;
};

/** Where the team's already-built environment is on a place, and what it holds.
 *
 *  One call for both place-modes. This laptop has one member and answers "it is
 *  yours, and you are already standing in it"; a shared box answers with the
 *  account that belongs to nobody, making it if it is not there yet. Asking is
 *  safe — the only thing it can create is an empty account with no key in it. */
export function askTeamBase(place: Place): Promise<TeamBase> {
  return api.placeTeamBase({
    root: place.project.root,
    machineId: place.machineId,
  });
}

/** Build the team's environment once, and start this member from it.
 *
 *  Minutes, not seconds, the first time: it is the project's whole declared
 *  install and then a copy of everything that install produced. The second
 *  member through finds the stamp already matching the spec and comes back with
 *  `already_built`, having run no install at all.
 *
 *  `force` rebuilds a base that is already at spec, and applies a spec whose
 *  seal this laptop's team registry cannot vouch for. */
export function warmStart(
  place: Place,
  login?: string,
  force = false,
): Promise<BaseBuild> {
  return api.placeTeamBaseWarm(
    { root: place.project.root, machineId: place.machineId },
    login,
    force,
  );
}

/** May a member be started from this base?
 *
 *  Three things, and the first is not a performance question. A base holding
 *  somebody's credential would copy it into every member's home, which is the
 *  one failure worse than a slow install. A base nobody can read is one nobody
 *  can start from, and it would fail one member at a time. A base whose tools
 *  installed into the machine rather than into itself is empty however many
 *  times the spec was applied to it. */
export function baseIsUsable(base: TeamBase): boolean {
  return base.carries.length === 0 && base.readable && base.scoped;
}

/** What is wrong with this base, in the terms somebody would act on — or `null`
 *  when nothing is.
 *
 *  The credential case is named first and names the file, because it is the only
 *  one where the right response is to go and look at the machine rather than to
 *  press the button again. */
export function baseWarning(base: TeamBase): string | null {
  if (base.carries.length > 0) {
    return `The team's environment on ${base.place} is holding something that belongs to one person (${base.carries.join(", ")}). Nothing will be copied out of it until that is gone — a shared environment carries downloads, never credentials.`;
  }
  if (!base.readable) {
    return `The team's environment on ${base.place} cannot be read by the members, so nobody can start from it.`;
  }
  if (!base.scoped) {
    return `The team's environment on ${base.place} installs into the machine rather than into itself, so there is nothing in it for anyone to start from.`;
  }
  return null;
}

/** Has this base ever been built, and to which spec?
 *
 *  A version of zero means never — an account that exists and holds nothing,
 *  which is the state the first member finds. */
export function baseWasBuilt(base: TeamBase): boolean {
  return base.built_version > 0 && base.built_digest.length > 0;
}

/** What to tell somebody after they joined a place.
 *
 *  Four different true things, and which one it is turns on who paid. The
 *  distinction worth spelling out is the second: a member who installed nothing
 *  because somebody else already had is the entire feature, and a surface that
 *  said only "ready" would have hidden the one number that makes a shared box
 *  worth having. */
export function warmSentence(build: BaseBuild): string {
  const { base, start } = build;
  if (start.alone) {
    return `One person works on ${base.place}, so its environment is yours — you are already standing in it.`;
  }
  if (start.refused) {
    return `Nothing was copied out of the team's environment on ${base.place}: ${start.refused}.`;
  }
  const came = start.seeded.length;
  if (build.already_built) {
    return came > 0
      ? `${base.place} was already built to this spec, so nothing was installed. ${countOf(came, "thing")} came across from the team's environment into ${start.member}'s home — ${listOf(start.seeded)}.`
      : `${base.place} was already built to this spec, and ${start.member} already had everything it holds.`;
  }
  return came > 0
    ? `${base.place} was brought to the project's spec in the team's environment, and ${countOf(came, "thing")} came across into ${start.member}'s home — ${listOf(start.seeded)}. The next person to join pays none of that.`
    : `${base.place} was brought to the project's spec in the team's environment. The next person to join starts from it instead of building it again.`;
}

/** Anything a member should know went wrong while they were being started, or
 *  `null`.
 *
 *  Kept apart from [`warmSentence`] because these fail apart: a copy that hit a
 *  full disk leaves a member with a home that looks warm and is short, and they
 *  find out in the middle of a build rather than here. */
export function warmShortfall(start: WarmStart): string | null {
  if (start.failed.length === 0) {
    return null;
  }
  return `${countOf(start.failed.length, "thing")} could not be copied into ${start.member}'s home (${start.failed.join(", ")}), so those will be downloaded again the first time something needs them.`;
}

function countOf(n: number, noun: string): string {
  return n === 1 ? `One ${noun}` : `${n} ${noun}s`;
}

function listOf(held: Held[]): string {
  const words = held.map((h) => h.holds || h.under);
  if (words.length <= 2) {
    return words.join(" and ");
  }
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
