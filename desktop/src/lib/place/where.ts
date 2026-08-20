// Where new work runs — asked, rather than inferred from where you happen to
// be standing.
//
// The place a workspace ran in used to be a consequence of navigation. You got
// a cloud workspace by walking into the machine and creating one there; from
// the New-workspace dialog the answer was always this laptop, and naming a
// machine was refused outright. So "run this on the big box" was not a choice
// anybody made — it was a route they had to know.
//
// This turns the one list (`places_list`) into the options that dialog offers.
// Nothing new is discovered here: the boxes are the ones the machine book
// already holds and the org half is the one the roster already merged. What is
// decided here is which of those rows may be OFFERED, which is a product
// question with two rules and they came from the user directly:
//
//   1. A project's own cloud appears only if that project has one set up.
//      Never a dead option. A row that would fail on click is worse than no
//      row: the person cannot tell "this isn't for you" from "this is broken".
//   2. A personal box is offered on EVERY project, because it belongs to the
//      person, not to the repo. You bought it, you connected it, and which
//      folder you happen to have open is none of its business.
//
// Between them those two rules decide every row, including the one they
// exclude: a place the ORG owns and that is filed under a DIFFERENT project is
// neither this project's cloud nor a box of yours, so it is left out rather
// than offered and then discovered to hold nothing you asked for.
//
// A place with no address on this laptop (`row.machine === null` — the org has
// it, you have never connected it) is never an option at all. That is rule 1
// again, in its sharpest form: there is nothing to dial.

import type { PlaceRoster, PlaceRow } from "../api";
import type { Place } from "./contract";
import { placeHere } from "./contract";
import { ownerLine, placeOfRow } from "./roster";

/** The three kinds of answer, which are three different sentences rather than
 *  three flavours of one. `here` is this computer. `project-cloud` is the box
 *  this project has been set up on. `my-box` is a machine you connected
 *  yourself, offered everywhere. */
export type WhereKind = "here" | "project-cloud" | "my-box";

/** The id of the local option. Stable, so a surface can remember a choice and
 *  fall back to this one when the place it remembered has gone. */
export const HERE = "here";

/** One row of the Where question. */
export type WhereOption = {
  /** React key, and the handle a surface remembers a choice by. */
  id: string;
  kind: WhereKind;
  /** The machine book's key, or `null` for this laptop — exactly the shape
   *  every call that reaches a place already takes, so choosing the local
   *  option is expressible in the same words as choosing a box. */
  machineId: string | null;
  place: Place;
  /** What to call it, in words a non-engineer reads without translating:
   *  "This laptop", "New Git's cloud", "aura-runner". Never an address. */
  label: string;
  /** The quiet second line — whose it is, and which machine it actually is. */
  detail: string;
  /** Where this project sits ON that place, when the book already knows.
   *  `null` means nobody has recorded it, and the honest move is to ask the box
   *  at the moment the option is picked rather than to guess a path here. */
  projectPath: string | null;
};

/** The places this project's new work can run in.
 *
 *  `projectName` is what to call the project in the cloud row's label — the
 *  dialog already has it on screen, and "New Git's cloud" is the whole point of
 *  passing it rather than printing the repo's path at somebody.
 *
 *  This laptop always leads, and is always present: it is the one place that
 *  cannot be unreachable, and a list whose first row is a machine makes the
 *  common answer the one you have to hunt for. */
export function whereOptions(
  roster: PlaceRoster | null,
  repoRoot: string | null,
  projectName: string,
): WhereOption[] {
  const options: WhereOption[] = [
    {
      id: HERE,
      kind: "here",
      machineId: null,
      place: placeHere(repoRoot, "This laptop"),
      label: "This laptop",
      detail: "The copy is made here, on this computer.",
      projectPath: repoRoot,
    },
  ];
  for (const row of roster?.places ?? []) {
    const option = optionOfRow(row, repoRoot, projectName);
    if (option) options.push(option);
  }
  return options;
}

/** One roster row, read as an option — or `null` when it isn't one.
 *
 *  Exported for the test that argues about the two product rules directly,
 *  which is the argument worth having in one place. */
export function optionOfRow(
  row: PlaceRow,
  repoRoot: string | null,
  projectName: string,
): WhereOption | null {
  // No address here: your org has this machine and this laptop cannot dial it.
  // Offering it would put a row on screen whose only possible outcome is a
  // failure, which is the exact thing rule 1 forbids.
  const machine = row.machine;
  if (!machine) return null;

  const place = placeOfRow(row);
  if (!place) return null;

  const filedHere = sameRoot(machine.project_root, repoRoot);
  const yours = row.owner.kind === "you";
  // The org's machine, filed under some other project. Not this project's
  // cloud, and not a box of yours — so neither rule puts it on the list.
  // A place nobody has filed at all is still offered: it is in your book, you
  // are the one who put it there, and "unfiled" is an absence of an answer
  // rather than an answer about a different project.
  if (!filedHere && !yours && (machine.project_root ?? "").trim() !== "") {
    return null;
  }

  const path = machine.repo_path?.trim();
  return {
    id: row.id,
    kind: filedHere ? "project-cloud" : "my-box",
    machineId: machine.id,
    place,
    label: filedHere ? `${projectName}'s cloud` : row.name,
    // The cloud row names the project, so it has to say which machine that is;
    // a box row is already named after its machine and would just repeat it.
    detail: filedHere ? `${row.name} · ${ownerLine(row)}` : ownerLine(row),
    projectPath: path ? path : null,
  };
}

/** The option a surface's remembered choice points at, or this laptop.
 *
 *  A box that has been forgotten, or a project's cloud seen from a project that
 *  doesn't have one, must not leave a surface holding an id that is no longer
 *  on the list — the next launch would name a machine nobody can reach. Falling
 *  back to the local option is the one answer that is always true. */
export function chosenWhere(options: WhereOption[], id: string | null): WhereOption {
  return options.find((o) => o.id === id) ?? options[0];
}

/** Two repo roots, compared the way a filesystem means them: a trailing slash
 *  is punctuation, not a different directory. The book is hand-editable and the
 *  wizard writes what it was given. */
function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\/+$/, "");
  const left = norm(a);
  return left !== "" && left === norm(b);
}
