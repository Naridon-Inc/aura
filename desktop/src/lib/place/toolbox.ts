// Installing something for just me, without root.
//
// The escape hatch that makes the declared spec tolerable. `.aura/settings.toml`
// is the right way to put a tool on a place — declare it, sign it, and every
// place converges on it — and it is right precisely because it is deliberate.
// That deliberateness is also why people route around it: nobody amends a
// signed, committed, team-wide spec to try something for an hour. What they do
// instead is `sudo npm install -g`, which on a shared box is one member
// changing everybody's machine, and the person it breaks is never the person
// who ran it.
//
// So this exists to make the hour-long experiment land somewhere it cannot hurt
// anyone: the member's own home, no privilege asked for, nothing outside it
// written. Two members can hold two versions of one tool and neither is the
// other's problem.
//
// Mirrors `manager::brain::place_toolbox` and takes a `Place` where the backend
// does, so an install cannot be arranged for one way of getting a place and not
// the other. The commands themselves are deliberately NOT spelled here: the
// backend derives them from `aura_env::managers`, which is the one place that
// knows what `cargo install` looks like, and a second opinion on this side
// would agree with it right up until the first fix.

import { api } from "../api";
import type { Place } from "./contract";

/** What a member asked to have, for themselves.
 *
 *  Spelled the way `.aura/settings.toml` spells a package, on purpose: a member
 *  whose hour-long experiment turned out to be worth keeping can paste the same
 *  three fields into the project's spec and have it mean the same thing for
 *  everybody. */
export type ToolAsk = {
  /** `npm`, `pnpm`, `bun`, `cargo`, `pip`, `go`, `gem` — the managers that have
   *  a per-member spelling. `apt`, `dnf`, `apk` and `brew` install for the
   *  whole machine and are refused with a sentence rather than run under
   *  `sudo`. */
  manager: string;
  name: string;
  /** Pinned, when the point of the experiment is which version. */
  version?: string;
  /** The binary it leaves behind, when that is not the package's own name —
   *  `@anthropic-ai/claude-code` leaves `claude`. */
  bin?: string;
};

/** What a place did about one member's install.
 *
 *  Every field is what the machine said rather than what was asked for, which
 *  is why `mine` can be false on a successful install: the tool is there, but
 *  the copy the member's own PATH finds is somebody else's. */
export type Installed = {
  /** The login the install actually ran as. */
  login: string;
  /** Their home, as that place spells it. */
  home: string;
  /** The binary that was asked for. */
  tool: string;
  /** `installed` — this call put it there; `already` — it was theirs before. */
  state: "installed" | "already";
  /** Where the binary is now, on the member's own PATH. Empty when it is on
   *  none, which is a different failure from not installing and has to read as
   *  one. */
  at: string;
  /** Is `at` inside this member's own home?
   *
   *  The acceptance criterion of the whole feature, as something a surface can
   *  render: false means what runs afterwards is the machine's copy or a
   *  neighbour's, and reporting success on that would be reporting the
   *  opposite of what happened. */
  mine: boolean;
};

/** Install one tool for the member whose session this is.
 *
 *  One call for both place-modes. This laptop has one member and installs into
 *  their home; a shared box has as many as it has accounts and installs into
 *  the one whose session this is. Neither needs root and neither reaches
 *  anything outside that home.
 *
 *  `home` is the member's own home directory *on that place* — what
 *  `placeMemberAccount` reported when the account was made. Passed rather than
 *  guessed, because `/home/<login>` is wrong on macOS, wrong on a box with a
 *  non-standard layout, and wrong for every account whose name is not its
 *  directory.
 *
 *  `login` is who this must be running as. With it set, a session that turns
 *  out to be somebody else refuses rather than installing into their home —
 *  which a session may well have the privilege to do, and which is the one
 *  thing "install for just me" must never mean. */
export function installForMe(
  place: Place,
  home: string,
  ask: ToolAsk,
  login?: string,
): Promise<Installed> {
  return api.placeInstallForMe(
    { root: place.project.root, machineId: place.machineId },
    home,
    ask,
    login,
  );
}

/** What to tell someone after an install.
 *
 *  Three different true things, and the third is the one worth spelling out: a
 *  tool that installed and then resolves to a machine-wide copy is not the
 *  install anybody thought they were getting, and a surface that said "done"
 *  would be lying quietly. */
export function installedSentence(got: Installed): string {
  if (!got.mine) {
    return got.at
      ? `${got.tool} runs from ${got.at}, which is not inside ${got.login}'s home — that is the machine's copy, not theirs.`
      : `${got.tool} installed, but nothing on ${got.login}'s PATH can run it yet.`;
  }
  return got.state === "installed"
    ? `${got.tool} is installed at ${got.at}, in ${got.login}'s own home. Nobody else here is changed by it.`
    : `${got.tool} was already ${got.login}'s, at ${got.at}.`;
}

/** Is this an install a surface should present as done? */
export function installWorked(got: Installed): boolean {
  return got.mine && got.at.length > 0;
}
