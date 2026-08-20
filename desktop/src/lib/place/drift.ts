// What a place has, set against what the project asks it for.
//
// The frontend half of `manager::brain::place_drift`, field for field, so the
// two cannot disagree about what drift is.
//
// The question this answers is the oldest one in the trade — "it works on my
// machine" — and the reason it was never answerable is that the two halves of
// the answer had never been introduced. `askCapabilities` knows what a place
// HAS. The environment spec knows what the project ASKS FOR. Neither is the
// answer alone: a probe cannot say a missing binary was ever wanted, and a spec
// cannot say what a place has that nobody declared — which is exactly where
// works-here-not-there lives, because the thing that differs between two boxes
// is almost always the thing nobody wrote down.
//
// Everything below the type definitions is presentation logic kept OUT of the
// component, for the ordinary reason: a `.tsx` in this codebase is not under
// test, and the decision about which of these lines a person is shown first is
// worth more than the markup around it.

import { api } from "../api";
import { AGENT_CANDIDATE_BINS } from "./capabilities";
import type { Place } from "./contract";

/** Where one line of the report sits in the stack. The order is the order
 *  things have to exist in, which is also the order to read them in: a missing
 *  runtime is why the toolchain step failed. */
export type DriftLayer =
  | "runtime"
  | "agent"
  | "toolchain"
  | "package"
  | "deps"
  | "service";

/** How one thing stands between what the place has and what was asked for.
 *
 *  Four cases, and `unasked` is the one that is easy to leave out and is the
 *  whole reason this is a diff rather than a checklist: a place holding a tool
 *  the spec never mentions is not a fault, it is the ANSWER to why the same
 *  commit behaves differently over there. There is deliberately no case for
 *  "not here and nobody wanted it" — a place is not short of something nobody
 *  asked for, and a list of every absence is a list nobody reads. */
export type DriftStanding = "missing" | "disputed" | "present" | "unasked";

/** One line of the diff. Mirrors `place_drift::DriftItem`. */
export type DriftItem = {
  /** Stable across places and runs, so two reports can be set side by side:
   *  `runtime:tmux`, `package:brew/ripgrep`, `agent:claude`. */
  id: string;
  title: string;
  layer: DriftLayer;
  standing: DriftStanding;
  /** What the place said, or what goes wrong without it. Never empty. */
  detail: string;
  /** The command that would close this gap, when the spec said how to. */
  fix: string | null;
};

/** Whether the spec measured against is one anyone should trust. Mirrors
 *  `aura_env::TrustState`, which serialises with a `state` tag. */
export type DriftTrust =
  | { state: "verified"; key_id: string; signer: string | null }
  | { state: "self_signed"; key_id: string }
  | { state: "unsigned" }
  | { state: "stale"; sealed: string; actual: string }
  | { state: "invalid"; detail: string };

/** A place, measured against the project it is holding. */
export type Drift = {
  place: string;
  /** Where the spec was read from — the place's own checkout, never this
   *  laptop's, because a box building last month's branch needs last month's
   *  spec. */
  spec_from: string;
  version: number;
  digest: string;
  trust: DriftTrust;
  /** Did the project declare an environment at all? False is a perfectly good
   *  state and changes what the report means: everything in it is then what the
   *  place turned out to have, with nothing to be short of. */
  declares_environment: boolean;
  items: DriftItem[];
  missing: number;
  disputed: number;
  at_spec: boolean;
  summary: string;
};

/** Ask a place what it has, against what the project asks it for.
 *
 *  One function for both place-modes, because it takes a `Place` rather than a
 *  machine id. That is not tidiness: the comparison anybody actually wants is
 *  the box against the laptop it works on, and a report you can only get about
 *  one end of that is worth nothing.
 *
 *  `deps` also measures the project's own `[worktree] setup` — its dependency
 *  manifests. Off by default because asking brew whether it has ripgrep is
 *  milliseconds and `npm ci` is not, and this is a question a panel asks on
 *  open.
 *
 *  THROWS when the place can't be reached, and the caller must hold `null`
 *  rather than an empty report: "we couldn't ask" is not "nothing is wrong". */
export function askDrift(
  place: Place,
  { deps = false, bins = AGENT_CANDIDATE_BINS }: { deps?: boolean; bins?: string[] } = {},
): Promise<Drift> {
  return api.placeDrift(
    { root: place.project.root, machineId: place.machineId },
    bins,
    deps,
  );
}

/** The lines that stop this place being what the project asked for — what a
 *  surface with room for three rows shows. */
export function blocking(drift: Drift): DriftItem[] {
  return drift.items.filter(
    (i) => i.standing === "missing" || i.standing === "disputed",
  );
}

/** What this place turned out to have that nothing declared.
 *
 *  Folded away by default and worth keeping: it is the half that explains a
 *  difference between two places when the spec is silent, and the usual fix is
 *  to declare it so every place brings itself to it. */
export function alsoHere(drift: Drift): DriftItem[] {
  return drift.items.filter((i) => i.standing === "unasked");
}

/** What was asked for and is here. The quiet majority. */
export function met(drift: Drift): DriftItem[] {
  return drift.items.filter((i) => i.standing === "present");
}

/** How a row should read: the accent it carries and the word in front of it.
 *
 *  Spelled here rather than in the component so the mapping is one decision in
 *  one place — a second component that picked its own colour for `disputed`
 *  would be a second opinion about how bad it is. */
export type DriftTone = "bad" | "warn" | "ok" | "info";

export function driftTone(standing: DriftStanding): DriftTone {
  switch (standing) {
    case "missing":
      return "bad";
    case "disputed":
      return "warn";
    case "present":
      return "ok";
    case "unasked":
      return "info";
  }
}

/** The word a row leads with — what it IS, not what it is called.
 *
 *  "Missing" and "here" rather than the type's own names: `unasked` is a fact
 *  about the spec, and the person reading the row wants the fact about the
 *  machine. */
export function standingWord(standing: DriftStanding): string {
  switch (standing) {
    case "missing":
      return "missing";
    case "disputed":
      return "in doubt";
    case "present":
      return "here";
    case "unasked":
      return "here, undeclared";
  }
}

/** One line for a header, when the header has one line.
 *
 *  Not the backend's `summary`, which names the place — a panel already says
 *  which place it is about, and repeating it there is the sentence people stop
 *  reading. */
export function driftHeadline(drift: Drift): string {
  if (!drift.declares_environment) {
    return "This project declares no environment — below is what this place has";
  }
  if (drift.at_spec) return `At spec v${drift.version}`;
  const parts: string[] = [];
  if (drift.missing) parts.push(`${drift.missing} missing`);
  if (drift.disputed) parts.push(`${drift.disputed} in doubt`);
  return `Behind spec v${drift.version} — ${parts.join(", ")}`;
}

/** What the seal on the spec says, when it says anything worth interrupting
 *  for.
 *
 *  `null` for the two states nobody needs to act on: verified, and a project
 *  that has never sealed one. A stale or broken seal is a different matter —
 *  the commands in that spec are the ones a place is about to run unattended,
 *  and an unreviewed edit is exactly the shape that arrives in. */
export function trustWarning(trust: DriftTrust): string | null {
  switch (trust.state) {
    case "stale":
      return "This spec has been edited since it was sealed — review the change and re-sign it before bringing anything to it";
    case "invalid":
      return `This spec's seal does not check out: ${trust.detail}`;
    case "self_signed":
      return "This spec is signed by a key this repo does not yet vouch for — publish it so teammates can verify";
    case "verified":
    case "unsigned":
      return null;
  }
}

/** The same two places, as the lines on which they differ.
 *
 *  The point of the whole feature, and the reason `id` is stable: given a report
 *  from each end, this is works-here-not-there as a list of rows rather than an
 *  afternoon. An id present on one side and absent on the other is a difference
 *  too — that is what `null` means here, and it is the commonest one.
 *
 *  Ordered by the left report, because the left one is the place you are
 *  standing on and the questions you have are about it. */
export function compare(
  left: Drift,
  right: Drift,
): Array<{ id: string; title: string; left: DriftItem | null; right: DriftItem | null }> {
  const byId = (d: Drift) => new Map(d.items.map((i) => [i.id, i] as const));
  const theirs = byId(right);
  const seen = new Set<string>();
  const rows: Array<{
    id: string;
    title: string;
    left: DriftItem | null;
    right: DriftItem | null;
  }> = [];
  for (const item of left.items) {
    seen.add(item.id);
    const other = theirs.get(item.id) ?? null;
    if (other && other.standing === item.standing) continue;
    rows.push({ id: item.id, title: item.title, left: item, right: other });
  }
  for (const item of right.items) {
    if (seen.has(item.id)) continue;
    rows.push({ id: item.id, title: item.title, left: null, right: item });
  }
  return rows;
}
