// One door to the wire, asked of the whole repo rather than of one language.
//
// `cloudbox/sole_ssh.rs` already makes this claim, and makes it well — but only
// about Rust, and only under `cargo test`. Both of those are holes, and the
// second one is the wider:
//
//   * The transport forked into TypeScript once already. `remoteShell.ts` built
//     `ssh -i … user@host '…'` out of three fields off a machine row, and the
//     Rust guard was green the entire time it existed, because it never looked
//     at a `.ts` file. There is nothing about that failure specific to
//     TypeScript: a shell script, a Python helper or the marketing site can
//     each hold a whole second way to reach a box.
//
//   * The crew's verify command is `bun test && tsc --noEmit && cargo check
//     --lib`. `cargo check` does not compile tests, so the Rust guard does not
//     run in the gate that decides whether work lands. A guard nothing runs is
//     a comment.
//
// So this is the same claim, taught every language in the repo and living in
// `bun test`, which the gate does run. The Rust guard stays exactly as it is:
// it asks deeper questions than this one can (that only `Place` dials, that
// every `box_*` command is a `Place` call), and it is the authority on Rust.
// This one is the wide, shallow half — nothing anywhere reaches the wire except
// through the door — and the two are pinned to each other below so neither can
// quietly go missing.
//
// ── What counts as reaching the wire ─────────────────────────────────────────
//
// Two things, and the second is the one people miss. Spawning `ssh` is obvious.
// *Assembling* an ssh argv is just as bad and looks harmless: a surface that
// builds its own `-i key -o StrictHostKeyChecking=… user@host` has forked the
// transport whether or not it runs it, because connection multiplexing, the
// agreed quoting, and whatever a managed place needs *instead* of ssh all live
// on the far side of the door. A place that is not reached over ssh at all
// could never be added to a line built here — which is the one thing this
// programme is not allowed to ship.

import { readable, isReadable } from "./sourceKinds";

/** The only file allowed to spawn `ssh`. */
export const THE_DOOR = "aura-shell/src-tauri/src/cloudbox/mod.rs";

/**
 * The only file allowed to walk through it.
 *
 * `Place::open` names the program and hands back the argv the door built. It is
 * the seam itself, which is why it holds the one other mention of the word.
 */
export const THE_DIALER = "aura-shell/src-tauri/src/manager/brain/place.rs";

/**
 * Everything under here is the door. The acceptance is worded "outside
 * cloudbox", and the door's own neighbours — the argv builder, the quoting, the
 * dialability rules, the Rust guard — are all it.
 */
export const THE_DOORWAY = "aura-shell/src-tauri/src/cloudbox/";

/** Why a file is allowed to hold what this forbids. */
export type ExemptionKind =
  /** The door, or the one caller that walks through it. */
  | "door"
  /**
   * A script a person runs from their own laptop to build or deploy
   * infrastructure. It is not a surface of the app, nothing the app ships can
   * reach it, and it predates the notion of a place — the box it is talking to
   * does not exist yet when it starts.
   */
  | "ops"
  /**
   * A drawing of a command rather than a command. It cannot spawn anything and
   * has nothing to spawn it with.
   */
  | "mock";

export type Exemption = {
  /** Repo-relative path, or a prefix ending in `/`. */
  path: string;
  kind: ExemptionKind;
  /** One sentence, for whoever finds this file wondering why. */
  why: string;
};

/**
 * The exemptions, each with its reason.
 *
 * A list like this is where a guard goes to die: one entry gets added under
 * deadline, then another, and the invariant is gone while the test still
 * passes. So every entry here also carries a *proof obligation* checked by
 * `unearnedExemptions` — an `ops` script must be unreachable from anything the
 * app ships, and a `mock` must have no way to spawn a process at all. An
 * exemption that stops being true fails the build exactly like a side door
 * does.
 */
export const EXEMPT: Exemption[] = [
  {
    path: THE_DOORWAY,
    kind: "door",
    why: "The door itself — `dial`, the argv it builds, and the quoting and dialability rules that go with it.",
  },
  {
    path: THE_DIALER,
    kind: "door",
    why: "`Place::open` is the one caller of the door; it names the program and hands back the argv cloudbox built for it.",
  },
  {
    path: "aura-runner/aws/provision.sh",
    kind: "ops",
    why: "Builds an EC2 box from a laptop and hands it over. It runs before the machine exists, so there is no place to ask — and nothing the app ships invokes it.",
  },
  {
    path: "release-0.19.34/deploy-0.19.34.sh",
    kind: "ops",
    why: "A release script rsyncing a built site to the web server. Its ssh reaches Aura's own infrastructure, not a user's place.",
  },
  {
    path: "release-0.19.35/deploy-0.19.35.sh",
    kind: "ops",
    why: "The same release script, one version on. Each cycle keeps its own copy so a shipped release can be re-deployed exactly as it went out, which is why these are listed one at a time rather than by a `release-*/` prefix that would exempt a directory nobody has written yet.",
  },
  {
    path: "release-0.19.36/deploy-0.19.36.sh",
    kind: "ops",
    why: "The 0.19.36 cycle's copy. Same reach as every other one — Aura's own web host — and nothing the app ships invokes it.",
  },
  {
    path: "release-0.19.37/deploy-0.19.37.sh",
    kind: "ops",
    why: "The 0.19.37 cycle's copy. Same reach: Aura's own web host, and nothing the app ships invokes it.",
  },
  {
    path: "release-0.19.37/deploy-mac.sh",
    kind: "ops",
    why: "The macOS half of the 0.19.37 cycle — the mac artefacts go up in their own pass, so the cycle is two scripts and both are listed rather than one standing in for the other.",
  },
  {
    path: "release-0.19.38/deploy-0.19.38.sh",
    kind: "ops",
    why: "The 0.19.38 cycle's copy. Same reach: Aura's own web host, and nothing the app ships invokes it.",
  },
  {
    path: "release-0.19.38/deploy-mac.sh",
    kind: "ops",
    why: "The macOS half of the 0.19.38 cycle, listed alongside its full-release sibling for the same reason the 0.19.37 pair are.",
  },
  {
    path: "release-0.19.31/deploy-mac-0.19.31.sh",
    kind: "ops",
    why: "The 0.19.31 cycle's macOS-only copy — that release shipped mac artefacts alone. Listed like the rest so a cycle still on disk cannot fail the gate for the branch that happens to be checked out.",
  },
  {
    path: "ship-0.19.33/deploy-0.19.33.sh",
    kind: "ops",
    why: "The 0.19.33 cycle's copy, under the name that cycle used. Same reach: Aura's own web host, and nothing the app ships invokes it.",
  },
  {
    path: "aura-cloud/deploy/deploy.sh",
    kind: "ops",
    why: "Deploys the cloud server to Aura's own host. The box on the other end is infrastructure this company runs, not a machine any user brought or was given.",
  },
  {
    path: "aura-web/src/v4/app/cloud/ConnectMachineWizard.tsx",
    kind: "mock",
    why: "The marketing site's scripted terminal. It prints a picture of the ssh line to show what connecting looks like; it is a static page with nothing to spawn a process with.",
  },
];

/** How a file gave itself away. */
export type Sighting = {
  path: string;
  /** 1-indexed, so it is clickable. */
  line: number;
  /** The line itself, trimmed — enough to see what was found. */
  text: string;
  /** Which rule caught it. */
  rule: "spawns" | "assembles";
};

/**
 * The word `ssh` used as the name of a program to run.
 *
 * Quoted, in any of the four ways this repo's languages quote things. A bare
 * `ssh` in prose is not this; a bare `ssh` at the head of a shell command is,
 * and is caught by `SHELL_COMMAND` below.
 */
const NAMED = /(["'`])ssh\1/;

/**
 * A shell script running ssh, which quotes nothing.
 *
 * Anchored to a command position — the start of a line, after a pipe or `&&`,
 * or inside a `$(…)` — so the `ssh` in `aura-runner-ssh-key` or in a word like
 * `sshfs` is not one.
 */
const SHELL_COMMAND = /(^|[;&|]|\$\(|\bthen\b|\bdo\b|\belse\b)\s*ssh\s+[-\w"'$]/;

/**
 * Options that belong to ssh and to nothing else.
 *
 * This is the half that catches an argv being *assembled*. Each of these is a
 * word nobody writes unless they are building a line to a box: the strict
 * host-key policy every one of these builders sets, the batch flag a
 * non-interactive question needs, and the multiplexing control path — which is
 * the one a second transport most conspicuously *lacks*, and therefore the one
 * whose appearance somewhere new means somebody rebuilt the connection by hand.
 *
 * `ForwardAgent` is the one with the sharpest consequence. A line that sets it
 * is a line handing a machine the use of the key on this laptop, and it must be
 * the line that also read the member's decision — a second builder setting it
 * would lend a box your key on a policy of its own.
 */
const SSH_OPTIONS =
  /StrictHostKeyChecking|UserKnownHostsFile|BatchMode=|ControlMaster|ControlPath|ControlPersist|ForwardAgent|IdentitiesOnly|PubkeyAuthentication|\bssh\s+-i\b|\bssh\s+-o\b|\bssh\s+-A\b/;

/**
 * Ways a file could spawn a process at all.
 *
 * Used to hold `mock` exemptions to their word: a drawing of a command that
 * grew a way to run one is no longer a drawing.
 */
const CAN_SPAWN =
  /child_process|node:child_process|\bexecFile\b|\bspawnSync\b|\bexecSync\b|Command::new|subprocess|os\.system|\binvoke\s*\(|Deno\.Command|Bun\.spawn/;

/**
 * `ssh` as the name of a protocol, mapped to its port.
 *
 * `"ssh" => 22` is a scheme-to-port lookup. It names the protocol, not a
 * program, and nothing on that line can reach a machine — the whole point of
 * such a table is usually to decide what a policy will *allow*.
 *
 * This is carved out of the rule rather than parked in [`EXEMPT`] on purpose.
 * An exemption would be per-file, so the next port table somewhere else fires
 * again and gets its own entry, and a list that grows one row per false alarm
 * is a list people stop reading. The distinction here is about the shape of the
 * line, so it holds wherever the line appears.
 *
 * Narrow deliberately: only a quoted `ssh` immediately mapped to a number, and
 * only when the line has no other way to reach anything. `{ program: "ssh",
 * port: 22 }` is not this — the comma is not a mapping — and neither is a line
 * that also names a way to spawn.
 */
const PORT_TABLE = /(["'`])ssh\1\s*(?:=>|:)\s*\d+/;

function namesTheProtocolNotTheProgram(line: string): boolean {
  return (
    PORT_TABLE.test(line) &&
    !CAN_SPAWN.test(line) &&
    !SHELL_COMMAND.test(line) &&
    !SSH_OPTIONS.test(line)
  );
}

/** Whether `path` is covered by `e` — a file, or anything under a prefix. */
function covers(e: Exemption, path: string): boolean {
  return e.path.endsWith("/") ? path.startsWith(e.path) : path === e.path;
}

/** The exemption covering a path, if any. */
export function exemptionFor(path: string): Exemption | null {
  return EXEMPT.find((e) => covers(e, path)) ?? null;
}

/**
 * Every way this file reaches the wire.
 *
 * Reads production source only — comments are blanked and Rust's test-gated
 * items are cut, because the claim is about what ships. A file in a language
 * this cannot read yields nothing, which `unreadableSources` then makes
 * visible rather than leaving as a silent hole.
 */
export function sightings(path: string, src: string): Sighting[] {
  const body = readable(path, src);
  if (!body) return [];
  const out: Sighting[] = [];
  const lines = body.split("\n");
  const original = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (namesTheProtocolNotTheProgram(line)) continue;
    const rule = NAMED.test(line) || SHELL_COMMAND.test(line)
      ? ("spawns" as const)
      : SSH_OPTIONS.test(line)
        ? ("assembles" as const)
        : null;
    if (!rule) continue;
    out.push({
      path,
      line: i + 1,
      text: (original[i] ?? line).trim(),
      rule,
    });
  }
  return out;
}

/** A file, as this guard reads them. */
export type Source = { path: string; text: string };

/**
 * Whether a path holds code that ships.
 *
 * The same exclusion Rust gets from `#[cfg(test)]`, spelled the way the other
 * languages spell it: a `.test.ts` is not bundled, is not installed, and is
 * routinely *made of* the patterns this guard hunts — `boot.test.ts` asserts
 * what an ssh line looks like, and `remoteShell.test.ts` keeps one as a
 * fixture. Reading those as side doors would make the guard fire on the tests
 * that prove there are none, which is the fastest way to get it deleted.
 *
 * A whole `tests/` directory goes the same way, and that is what lets this
 * module live in one without needing an exemption for itself. A guard has to
 * write down the shapes it forbids in order to look for them; a guard that then
 * had to name itself in its own allowlist would be one edit away from the
 * allowlist being the feature.
 */
export function isProductionSource(path: string): boolean {
  return (
    !/\.(test|spec)\.[jt]sx?$/.test(path) &&
    !/\.d\.ts$/.test(path) &&
    !/(^|\/)(tests|__tests__|__mocks__|test_fixtures)\//.test(path) &&
    !/(^|\/)test_[^/]+\.py$/.test(path) &&
    !/_test\.go$/.test(path)
  );
}

/**
 * Every file reaching the wire that is not the door and not exempt.
 *
 * This is the assertion. An empty result is the invariant holding.
 */
export function sideDoors(files: Source[]): Sighting[] {
  return files
    .filter((f) => !exemptionFor(f.path))
    .flatMap((f) => sightings(f.path, f.text));
}

/**
 * Exemptions that no longer deserve to be exemptions.
 *
 * The list above is only worth having if it cannot rot. An `ops` script earns
 * its place by being unreachable from what the app ships — the moment something
 * shipped calls it, it is a transport with a shell script in the middle. A
 * `mock` earns its place by having nothing to spawn with; the moment it can
 * spawn, its drawing of a command is a command.
 */
export function unearnedExemptions(files: Source[]): string[] {
  const out: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.text]));

  for (const e of EXEMPT) {
    if (e.kind === "mock" || e.kind === "guard") {
      const src = byPath.get(e.path);
      if (src === undefined) {
        out.push(`${e.path} is exempt but no longer exists — drop the exemption`);
        continue;
      }
      if (CAN_SPAWN.test(readable(e.path, src))) {
        out.push(
          `${e.path} is exempt as something that only describes a command, but it can now run one`,
        );
      }
    }
    if (e.kind === "ops") {
      const name = e.path.slice(e.path.lastIndexOf("/") + 1);
      const callers = files
        .filter((f) => !exemptionFor(f.path) && ships(f.path))
        .filter((f) => readable(f.path, f.text).includes(name))
        .map((f) => f.path);
      if (callers.length > 0) {
        out.push(
          `${e.path} is exempt as an ops script nothing ships, but ${callers.join(", ")} reach${
            callers.length === 1 ? "es" : ""
          } it`,
        );
      }
    }
  }
  return out;
}

/**
 * Whether a path is part of something a user installs.
 *
 * Ops scripts, fixtures and the loop's own scaffolding are not — an `ops`
 * exemption is about what *ships* being unable to reach it, and a second ops
 * script mentioning the first is two people at the same laptop, not a
 * transport.
 */
function ships(path: string): boolean {
  return (
    /^(aura-shell|aura-cli|aura-cloud|aura-daemon|aura-runner|aura-mobile|aura-vscode|crates)\//.test(
      path,
    ) && !/(^|\/)(scripts|aws|deploy)\//.test(path)
  );
}

/**
 * Files whose language this guard cannot read.
 *
 * Not a failure — most of them are JSON and Markdown. It is reported so that
 * "no side doors were found" can be told apart from "nothing was read", which
 * are the same result and opposite facts.
 */
export function unreadableSources(files: Source[]): string[] {
  return files.filter((f) => !isReadable(f.path)).map((f) => f.path);
}
