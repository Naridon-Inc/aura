// What a place offers, read for a screen.
//
// The narrowing itself is on the Rust side (`manager::brain::place_projects`),
// where both halves already live — the projects come off the box over the shared
// ssh connection and the org's registry is a call this process makes. A rule
// re-decided up here would be a second opinion about which repos a member may
// see, and the two would disagree on the first correction.
//
// What is left is the part a screen needs: the sentence above the list, the
// sentence beside a project somebody expected and cannot find, and the one
// question every surface that picks a project has to be able to answer —
// "it's on the machine, why isn't it in the dropdown?"

import type { PlaceProjects, WithheldProject } from "../api";

/** Nothing asked yet. Distinct from a place that answered "no projects": one is
 *  a spinner and the other is an empty machine, and a surface that draws them
 *  the same way tells somebody their box is bare while it is still being read. */
export const UNREAD: PlaceProjects = {
  org: null,
  org_name: null,
  projects: [],
  withheld: [],
  narrowed: false,
  notice: "",
};

/** What to say above the list, or null when it needs no explaining.
 *
 *  Three states, not two, and only two of them have anything to say. A personal
 *  box offering its own projects is the normal case and gets silence; a narrowed
 *  list says what it left out; a list that *could not* be narrowed says why,
 *  because that is a fact about the network rather than about the machine and
 *  the answer to it is to try again. */
export function projectsNotice(found: PlaceProjects): string | null {
  const notice = found.notice.trim();
  return notice ? notice : null;
}

/** Whether the notice is the "we couldn't find out" kind.
 *
 *  Worth asking separately because the two read differently on screen: a clean
 *  filter is ordinary and belongs in the quiet colour, while "showing everything
 *  because we couldn't reach your org" is a warning about the list being wider
 *  than you asked for. */
export function isUnnarrowed(found: PlaceProjects): boolean {
  return !found.narrowed && found.notice.trim().length > 0;
}

/** The reason a named project isn't on offer, or null if it is — or if the place
 *  never mentioned it at all.
 *
 *  `name` is matched as a folder name or as a full path, because the two callers
 *  hold different halves: a picker knows what somebody typed and the workspace
 *  composer knows the path it was looking for. */
export function whyNotOffered(
  found: PlaceProjects,
  name: string,
): string | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const hit = found.withheld.find(
    (w) => w.name === wanted || w.path === wanted || leaf(w.path) === leaf(wanted),
  );
  return hit ? hit.reason : null;
}

/** Every project held back, in a stable order — path, so the list doesn't
 *  reshuffle between two reads of the same box. */
export function withheldProjects(found: PlaceProjects): WithheldProject[] {
  return [...found.withheld].sort((a, b) => a.path.localeCompare(b.path));
}

/** The last segment of a path on the place. Paths there are POSIX whatever this
 *  laptop is, so this is deliberately not the platform's own path module. */
function leaf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
