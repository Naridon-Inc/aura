// One project per repository, however many of its checkouts you opened.
//
// The roster draws a group per remembered root and lists that root's whole
// worktree fleet under it. That is right until two of the remembered roots are
// two checkouts of the SAME repository — then `git worktree list` answers both
// with the same fleet and the sidebar shows the project twice, each copy
// claiming the same 381 parallel copies, with the same names in the same
// order. Nothing is wrong with the data; the list was keyed by the folder you
// happened to open rather than by the repo that folder belongs to.
//
// It is easy to land in: opening a worktree of a repo you already have open
// does it, and so does any agent CLI that parks its checkouts outside the repo
// (`~/.codex/worktrees/<task>/<RepoName>` is a real one, and the path-shaped
// guard in `hudProjects` cannot know every such store).
//
// So the key is git's own answer, not the path: every checkout of a repo
// reports the same main worktree, so that is the repo's identity and the thing
// the roster should draw. The copy you opened is not lost — it is a row inside
// the fleet, and `activePath` still lights it.

import type { WorktreeRef } from "./workspaceRef";

/** A repository and every checkout of it the app can see. */
export type ProjectFleet = {
  /** The repo's home checkout — what the roster draws as the project. Falls
   *  back to the opened root while git hasn't answered for it yet. */
  root: string;
  /** Git's worktree list for this repo: every parallel copy, including the
   *  home checkout. Empty when the enumeration hasn't landed (or failed) — the
   *  roster synthesises a single row in that case, as it always has. */
  worktrees: WorktreeRef[];
  /** The remembered roots that folded into this project, oldest first. The
   *  opened checkout is in here even when it isn't `root`. */
  members: string[];
};

/** Trailing slashes are not identity — `/a/b` and `/a/b/` are one place. */
function norm(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The repo a checkout belongs to, as git sees it: the main worktree's path.
 *  Unknown (no listing yet, or a folder that is no repo at all) means the
 *  checkout stands for itself — guessing would merge two real projects. */
function repoKey(root: string, fleet: WorktreeRef[] | undefined): string {
  const main = fleet?.find((w) => w.is_main)?.path;
  return main ? norm(main) : norm(root);
}

/** Fold remembered roots into one entry per repository, first-seen order.
 *
 *  `worktreesByRoot` is the lazily-filled cache the app already keeps; a root
 *  missing from it simply hasn't been enumerated yet and stands alone until it
 *  is, which is why this is worth recomputing as that cache fills. */
export function foldFleets(
  roots: string[],
  worktreesByRoot: Record<string, WorktreeRef[]>,
): ProjectFleet[] {
  const byRepo = new Map<string, ProjectFleet>();
  for (const raw of roots) {
    if (!raw) continue;
    const root = norm(raw);
    const fleet = worktreesByRoot[raw] ?? worktreesByRoot[root];
    const key = repoKey(root, fleet);
    const existing = byRepo.get(key);
    if (!existing) {
      byRepo.set(key, {
        root: key,
        worktrees: fleet ?? [],
        members: [root],
      });
      continue;
    }
    existing.members.push(root);
    // A later member may be the one that got enumerated — the fleet is the
    // same list whichever checkout answered, so take the first real one.
    if (existing.worktrees.length === 0 && fleet) existing.worktrees = fleet;
  }
  return [...byRepo.values()];
}

/** Which project a checkout is in — for the places that still hold a raw root
 *  (the open project, a keyboard cycle) and need to point at the row the
 *  roster actually drew. Returns the root unchanged when nothing claims it. */
export function fleetRootFor(fleets: ProjectFleet[], root: string): string {
  if (!root) return root;
  const target = norm(root);
  const hit = fleets.find(
    (f) => f.root === target || f.members.includes(target),
  );
  return hit?.root ?? target;
}

/** True when `root` is the open checkout of this project — the project header
 *  lights for the copy you are in, not only for the home checkout. */
export function fleetHoldsRoot(fleet: ProjectFleet, root: string): boolean {
  if (!root) return false;
  const target = norm(root);
  return fleet.root === target || fleet.members.includes(target);
}
