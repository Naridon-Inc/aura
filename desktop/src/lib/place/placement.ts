// Which project a place belongs beside, and what its row is called.
//
// A place is not a category of thing to be listed away from your work. You
// connected it *for* a project, and the sidebar reads best when it says so: the
// remote copy of New Git sits under New Git, beside the local copies, and the
// only thing that marks it out is the cloud glyph and the box it runs on.
//
// That needs an answer to one question — which project is this place for — and
// the honest answer is sometimes "we don't know yet". A place connected before
// the book recorded it, or connected outside any project, has no root. Guessing
// one would file a box under a repo it has never seen, so those stand on their
// own instead. Same rule as capabilities, one level up: an absent answer is not
// a wrong answer wearing confidence.

import type { Place } from "./contract";

export type PlaceFiling = {
  /** Places filed under a project the rail is actually showing, keyed by that
   *  project's repo root. Order within a bucket is the order given, which is
   *  `machines_list`'s order: most recently used first. */
  byProject: Map<string, Place[]>;
  /** Places with no project, or one this rail isn't showing — a box for a
   *  project you closed is still a box you can open. */
  unplaced: Place[];
};

/** Split the places across the projects on screen.
 *
 *  `knownRoots` is the set of project roots the rail is drawing. A place filed
 *  under a project that isn't in it — closed, archived, on another device's
 *  list — is unplaced rather than dropped: it would otherwise vanish from the
 *  app entirely and take the only address for that box with it. */
export function filePlaces(
  places: readonly Place[],
  knownRoots: ReadonlySet<string>,
): PlaceFiling {
  const byProject = new Map<string, Place[]>();
  const unplaced: Place[] = [];
  for (const p of places) {
    const root = p.project.root;
    if (!root || !knownRoots.has(root)) {
      unplaced.push(p);
      continue;
    }
    const bucket = byProject.get(root);
    if (bucket) bucket.push(p);
    else byProject.set(root, [p]);
  }
  return { byProject, unplaced };
}

/** What to call a place's row in the rail.
 *
 *  Every other row in that list names a piece of work — a branch, a copy, the
 *  thing you would go there to do. The machine row named a computer, so the one
 *  row that could have told you what is happening somewhere else told you only
 *  that somewhere else exists. Under a project called New Git, "aura-runner"
 *  and "aura-runner" are two boxes doing two completely different things and
 *  the rail drew them identically.
 *
 *  So: the branch checked out over there, or failing that the directory the
 *  project sits in, or failing that the place's own name. Each fallback is a
 *  real answer to "which work", getting vaguer only as the place tells us less
 *  — and the name never disappears, it moves to `machine`, which the row shows
 *  underneath and the tooltip spells out in full.
 *
 *  Deliberately NOT the address. An IP is unreadable at a glance, changes under
 *  you when the box restarts, and in a 232px rail costs more than every other
 *  row pays. */
export function placeRowLabel(p: Place): { work: string; machine: string } {
  const branch = p.project.branch;
  if (branch) return { work: branch, machine: p.name };
  const dir = p.project.path?.replace(/\/+$/, "");
  if (dir) {
    const base = dir.slice(dir.lastIndexOf("/") + 1);
    if (base) return { work: base, machine: p.name };
  }
  // Nothing is checked out there that we know of. The place's own name is the
  // last true thing we have, and repeating it underneath would be noise.
  return { work: p.name, machine: "" };
}

/** The project a workspace should file a place under, when the place has not
 *  named one yet.
 *
 *  Entering is the moment we learn this for free: you clicked it from a
 *  project, or you arrived through a cloud conversation that names its repo.
 *  Returning `null` means "still don't know" — say nothing rather than write a
 *  guess into the book, because a wrong entry is worse than an absent one and
 *  the rail's unplaced list already handles absence.
 *
 *  A place that HAS a root keeps it. Re-filing it every time you open it from
 *  somewhere else would make its position depend on where you happened to come
 *  from, which is the opposite of a place. */
export function projectToFilePlaceUnder(
  place: Place | null,
  arrivedFromRoot: string | null | undefined,
): string | null {
  if (!place) return null;
  if (place.project.root) return null;
  const root = arrivedFromRoot?.trim();
  return root ? root : null;
}
