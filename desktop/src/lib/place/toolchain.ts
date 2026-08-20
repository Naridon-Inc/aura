// Where a member's global installs land at a place, and whether a teammate
// would land on top of them.
//
// The other half of "commits are authored by the person who made them": `author`
// keeps two members' names apart, this keeps their toolchains apart. Both are
// the same bug wearing two hats — on a shared place, anything that defaults to
// the machine instead of the member silently becomes everybody's.
//
// Mirrors `manager::brain::place_toolchain` field for field. Note what is NOT
// here: the writing. The scoping is laid down when a member's account is made
// (`placeMemberAccount`), because that is the moment there is a home to scope it
// to; this is the read-out, so a surface can say whether an existing place —
// one somebody set up months ago — actually separates its members.

import { api } from "../api";
import type { Place } from "./contract";

/** Where one tool's state actually lives, from the member's point of view. */
export type Scope =
  /** Under this member's own home. Theirs. */
  | { scope: "mine" }
  /** Somewhere every account on this machine writes — `/usr/local` and friends. */
  | { scope: "everybody"; path: string }
  /** Inside a different member's home. The worst case, because it looks scoped
   *  right up until somebody reads the path. */
  | { scope: "someone_else"; path: string }
  /** Not set. Whether that is fine depends on the tool: npm's prefix defaults to
   *  `/usr/local` and is everybody's, the rest default to the member's home. */
  | { scope: "unset"; shared_by_default: boolean };

/** One variable, as the place answered it. */
export type VarState = {
  var: string;
  tool: string;
  /** What a login shell of theirs exports, verbatim. Empty when unset. */
  value: string;
  scope: Scope;
  /** What breaks if this one is shared, in the words of the thing that actually
   *  breaks rather than the name of the variable. */
  collides: string;
};

/** What a place holds for one member's tooling. */
export type ToolchainReport = {
  place: string;
  login: string;
  /** Their home, as the box spells it. */
  home: string;
  /** The login that answered. */
  you: string;
  /** Could a login shell be started as them and read? False is not a failure —
   *  it means nobody could become that member from this session — but the rows
   *  are then what their profile says rather than what their shell does. */
  observed: boolean;
  /** Is Aura's scoping block in their profile? */
  scoped: boolean;
  vars: VarState[];
};

/** Would two members collide on this one? */
export function collides(scope: Scope): boolean {
  switch (scope.scope) {
    case "mine":
      return false;
    case "everybody":
    case "someone_else":
      return true;
    case "unset":
      return scope.shared_by_default;
  }
}

/** Ask a place where this member's global installs go.
 *
 *  One function for both place-modes, because it takes a `Place`. This laptop
 *  answers it about the account somebody is sitting at — a real answer, usually
 *  "yes, they are yours, there is nobody else here" — and a box answers it about
 *  one member among several. */
export function askToolchain(
  place: Place,
  login?: string,
): Promise<ToolchainReport> {
  return api.placeToolchain(
    { root: place.project.root, machineId: place.machineId },
    login,
  );
}

/** The variables two members would collide on. Empty is the answer to aim for. */
export function collisions(report: ToolchainReport): VarState[] {
  return report.vars.filter((v) => collides(v.scope));
}

export function separated(report: ToolchainReport): boolean {
  return collisions(report).length === 0;
}

/** The sentence to show about this member's tooling.
 *
 *  One phrasing, so every surface says it the same way — and it names the tools
 *  rather than the variables, because the person reading it is about to run
 *  `npm install -g`, not to edit their environment. */
export function toolchainSentence(report: ToolchainReport): string {
  const hit = collisions(report);
  if (hit.length === 0) {
    return `Your installs on ${report.place} go into your own home — a teammate's won't touch them.`;
  }
  const tools = [...new Set(hit.map((v) => v.tool))].join(", ");
  return `On ${report.place}, ${tools} ${hit.length === 1 ? "keeps its state" : "keep their state"} somewhere you share with your teammates, so an install can overwrite theirs.`;
}
