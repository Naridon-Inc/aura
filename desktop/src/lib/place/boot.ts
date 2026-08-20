// Getting a terminal into a place — by asking, not by building one.
//
// This is the file that used to be `remoteShell.ts`, and the difference is the
// whole point of it existing. That module took three fields off a machine row
// and assembled `ssh -i "…" -o … user@host '…'` in TypeScript, which meant the
// app had two transports to a box: the Rust one, behind `Place`, with connection
// multiplexing, one agreed quoting and every verb the parity matrix proves — and
// this one, reached by a different route, with none of it.
//
// Nobody would have called that a bug. It worked. It is exactly the shape of
// failure this programme exists to prevent: a way of *getting* a machine that
// quietly has fewer features than the other, discovered by a user rather than by
// a test. An Aura-managed VM needs a different transport entirely, and the day it
// arrives the Rust side will grow one — while a line built out here would keep
// dialling ssh at a host that no longer answers to one.
//
// So the terminal asks. `place_boot` hands back the *same argv* `Place::open`
// would have spawned, rendered as one line, because the two surfaces that open
// terminals don't own their pty — the workspace and the connect wizard both
// start the user's own shell on this laptop, and the only way into one is to
// type.

import { api } from "../api";
import type { Place, PlaceKind } from "./contract";

/** What to open at a place.
 *
 *  Mirrors `place_contract::Open`, tag and field names included — this value is
 *  serialised straight across, so `read_only` is spelled the way Rust spells it
 *  rather than the way the frontend would. Three cases because there are three
 *  things people do with a machine: start a shell, start an agent, or sit down
 *  in front of something already running. */
export type PlaceOpen =
  | { what: "shell"; session: string | null }
  | {
      what: "agent";
      bin: string;
      prompt: string | null;
      session: string | null;
    }
  | { what: "attach"; session: string; read_only: boolean };

/** A login shell. Name a session and tmux holds it, so it outlives the window;
 *  leave it null for a shell that ends when the tab does. */
export function openShell(session: string | null = null): PlaceOpen {
  return { what: "shell", session };
}

/** A coding agent, running AT the place. `prompt` is the first thing said to
 *  it; null leaves it at its own prompt. */
export function openAgent(
  bin: string,
  opts?: { prompt?: string | null; session?: string | null },
): PlaceOpen {
  return {
    what: "agent",
    bin,
    prompt: opts?.prompt ?? null,
    session: opts?.session ?? null,
  };
}

/** Join something already running — the verb that makes a box worth having.
 *  `readOnly` watches without taking the keyboard, which is how two people
 *  follow one agent without typing over each other. */
export function openAttach(session: string, readOnly = false): PlaceOpen {
  return { what: "attach", session, read_only: readOnly };
}

/** A place named by where it is, rather than by a row in the machine book.
 *
 *  One caller, and it is not an oversight: the connect wizard opens a terminal
 *  on a box *before* the book has heard of it. That order is deliberate — the
 *  shell answering is what proves the address works, so a mistyped host leaves
 *  no row behind — which means there is no machine id to pass yet.
 *
 *  Mirrors `place_contract::Address`, `key_path` included, which is a path on
 *  THIS laptop and never key material. */
export type PlaceAddress = {
  user: string;
  host: string;
  key_path: string;
  /** Never `"here"`: this laptop has no address, and giving it a plausible one
   *  leaves a value some later surface tries to dial. */
  kind: Exclude<PlaceKind, "here">;
};

/** The line that opens a terminal here, asked of the place itself.
 *
 *  Both place-modes go through this one call, which is the entire reason it
 *  takes a `Place` rather than a machine id: a box is reached over ssh and this
 *  laptop through `sh`, and everything *inside* the command — cd into the root,
 *  hold it under tmux, degrade to a login shell when tmux isn't there — is the
 *  same body either way, written once in Rust.
 *
 *  THROWS when the place can't be named or the ask can't be held: an address
 *  that isn't one, a session name carrying a second command, a machine id the
 *  book doesn't have. A caller must show that rather than boot a terminal with
 *  a fallback line of its own — a fallback line is how this got two transports
 *  the first time. */
export function askBoot(place: Place, open: PlaceOpen): Promise<string> {
  return api.placeBoot(
    { root: place.project.root, machineId: place.machineId },
    open,
  );
}

/** The same, for a box that isn't in the machine book yet. See [`PlaceAddress`]. */
export function askBootAt(
  address: PlaceAddress,
  open: PlaceOpen,
): Promise<string> {
  return api.placeBoot({ address }, open);
}

/** What a host or a login may be made of.
 *
 *  Stricter than DNS on purpose. These go into an argv slot ssh parses itself,
 *  and the machine book is a file on disk: a hand-edited row reading
 *  `-oProxyCommand=…` is an instruction, not an address. No user has ever typed
 *  a legitimate host with a semicolon in it. */
const DIALABLE_NAME = /^[A-Za-z0-9._-]+$/;

/** Can this laptop dial that?
 *
 *  A copy of `cloudbox::is_dialable`, and it is a copy for one reason: a form
 *  validates as you type and a button has to be enabled before anything is
 *  asked, neither of which can afford a round trip per keystroke. Rust stays the
 *  authority — every place that actually reaches a machine passes through it —
 *  and the two are pinned to each other by `dialable.cases.json` rather than by
 *  a comment asking people to look.
 *
 *  Note what is not checked: what is in the key path. That path never reaches a
 *  shell unquoted, so refusing a space or an apostrophe in it would only lock
 *  someone out of their own key. */
export function isDialableAddress(a: {
  user: string;
  host: string;
  key_path: string;
}): boolean {
  return (
    dialableName(a.user) &&
    dialableName(a.host) &&
    a.key_path.trim().length > 0
  );
}

/** Is `v` a host or a login this laptop will dial? */
export function dialableName(v: string): boolean {
  const t = v.trim();
  return t.length > 0 && t.length <= 255 && DIALABLE_NAME.test(t);
}

/** Can a terminal be opened at this place at all?
 *
 *  Asked of the place rather than of an address, because the answer for this
 *  laptop is yes and has nothing to do with dialling: there is no address, no
 *  key and nothing that could be malformed. A gate spelled `isDialable` would
 *  have said no here and disabled the button on the one place that is always
 *  reachable — a feature missing from a place-mode by accident of naming. */
export function canOpenTerminal(place: Place): boolean {
  if (place.identity.kind === "here") return true;
  const { user, host, key_path } = place.identity;
  return (
    host !== null &&
    key_path !== null &&
    isDialableAddress({ user, host, key_path })
  );
}
