// The one list, read for a screen: whose each place is, who added it, and what
// this laptop may do with it.
//
// The merge itself is on the Rust side (`place_roster::roster`), where both
// halves already live — the `0600` machine book is a file this process reads and
// the org's board is a call this process makes, and a merge done up here would
// have meant shipping the book across the bridge twice and re-deciding the
// answer in every surface that drew a list.
//
// What is left is the part a screen needs and a server has no opinion about:
// which of these rows is a `Place` you can enter, and the sentences beside it.
// Both are here rather than in the component for the usual reason — a second
// list of machines would otherwise get its own spelling of "Naridon's, added by
// @ana" and the two would drift on the first correction.
//
// ## A row is not always a place
//
// `Place` means somewhere work runs, and `machineId: null` in that type means
// THIS LAPTOP. An org place this laptop has no address for is neither: it is
// somewhere work runs that you cannot yet reach. So it gets `place: null` and a
// Connect action, and no code path anywhere is tempted to hand a blank host to
// something that opens a shell.

import type { PlaceOrgHalf, PlaceRoster, PlaceRow } from "../api";
import type { Place } from "./contract";
import { placeOfMachine } from "./contract";

/** One row, plus the place it is — when it is one. */
export type RosterEntry = {
  row: PlaceRow;
  /** The place to enter, or `null` for an org place with no address here.
   *  Never `placeHere`: this laptop is not what an unconnected box is. */
  place: Place | null;
};

/** Read the backend's rows as entries, keeping the order it sent.
 *
 *  That order is the answer to "which one did you mean": the places you can
 *  enter first, most recently used first, then your org's places you would have
 *  to connect, live ones first. Re-sorting here would put the surface's opinion
 *  above the one the whole app shares. */
export function rosterEntries(roster: PlaceRoster): RosterEntry[] {
  return roster.places.map((row) => ({ row, place: placeOfRow(row) }));
}

/** The place a row describes, or null.
 *
 *  `capabilities` stays null even when the org's board listed the agent CLIs
 *  this machine runs. Those are two different questions: the board says what a
 *  runner REPORTED at registration, and `PlaceCapabilities` is what was read off
 *  the place — including `git`, `tmux` and `aura`, which the board has never
 *  been asked about. Filling three of four fields with `false` would answer a
 *  question nobody asked with a machine's worst day. `row.agents` carries the
 *  board's half for a surface that wants it. */
export function placeOfRow(row: PlaceRow): Place | null {
  return row.machine ? placeOfMachine(row.machine) : null;
}

/** Whose it is, in words, and whether you can get in.
 *
 *  The second clause is the one that earns its space. "Naridon's" alone leaves
 *  two rows looking identical when one opens on click and the other cannot —
 *  which is exactly the state this list was merged to make visible. */
export function ownerLine(row: PlaceRow): string {
  switch (row.source) {
    case "mine":
      return "Yours";
    case "both":
      return `${row.owner.label}'s — you have the address`;
    case "org":
      return `${row.owner.label}'s — not connected here`;
  }
}

/** Who put it there. */
export function addedByLine(row: PlaceRow): string {
  if (row.added_by.is_you) return "Added by you";
  if (row.added_by.label === "not recorded") return "Who added it isn't recorded";
  return `Added by ${row.added_by.label}`;
}

/** The whole row in one string, for a tooltip: whose, who added it, what you
 *  may do. The rights sentence is the backend's own, so the words on the tooltip
 *  and the buttons that are enabled cannot say different things. */
export function rowTooltip(row: PlaceRow): string {
  return `${ownerLine(row)} · ${addedByLine(row)}\n${row.may.summary}`;
}

/** What to say above the list when the org half is missing, or null when it
 *  isn't.
 *
 *  Three states, not two. "You have no team machines" and "we could not find
 *  out" look the same on screen and mean opposite things, and the second one is
 *  the one where the answer is to try again rather than to go and buy a
 *  machine. */
export function orgNotice(org: PlaceOrgHalf): string | null {
  if (org.status === "ok") return null;
  if (org.status === "signed_out") {
    return "Sign in to Aura Cloud to see the places your org has.";
  }
  const who = orgName(org);
  const detail = org.detail.trim();
  const head = `Couldn't reach ${who} — showing the boxes on this laptop.`;
  return detail ? `${head} ${detail}` : head;
}

/** What to say when there is nothing at all.
 *
 *  Empty means something different in each of the three states, and a single
 *  "No machines" would be a claim we can only make in one of them. */
export function emptyLine(org: PlaceOrgHalf): string {
  if (org.status === "unreachable") {
    return `No machines on this laptop, and ${orgName(org)} couldn't be asked for theirs.`;
  }
  if (org.status === "signed_out") {
    return "No machines on this laptop yet.";
  }
  return `No machines yet — neither yours nor ${orgName(org)}'s.`;
}

/** The org, named as well as we can. `null` for both fields is a real state —
 *  a token with no org recorded yet — and "your org" is the true part of it. */
function orgName(org: PlaceOrgHalf): string {
  const name = org.name?.trim();
  if (name) return name;
  const slug = org.slug?.trim();
  return slug ? slug : "your org";
}
