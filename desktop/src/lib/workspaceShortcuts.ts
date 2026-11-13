// What ⌘⇧A archives: the workspace in front, when it is a copy.
//
// A workspace here is one checkout row in the sidebar. The project's own
// folder is a row too, but archiving it is the repository's menu's job
// ("Archive repository"), so the shortcut only ever archives a copy, the same
// rule the row's own right-click menu follows.

import type { WorktreeRef } from "./workspaceRef";

export type ArchiveTarget =
  | { kind: "none" }
  | { kind: "main"; path: string }
  | { kind: "copy"; path: string };

function bare(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** The checkout `root` names, looked up in every project's worktree list.
 *  A folder no list knows is the project itself (a plain folder, or one whose
 *  copies have not been listed yet), so it is never taken for a copy. */
export function archiveTarget(
  root: string | null | undefined,
  worktreesByRoot: Record<string, WorktreeRef[] | undefined>,
): ArchiveTarget {
  if (!root) return { kind: "none" };
  const here = bare(root);
  for (const list of Object.values(worktreesByRoot)) {
    const hit = list?.find((w) => bare(w.path) === here);
    if (hit) return hit.is_main ? { kind: "main", path: root } : { kind: "copy", path: hit.path };
  }
  return { kind: "main", path: root };
}

/** Asked by ⌥⌘A: whoever draws the add-project menu sets `handled`, so the
 *  app can fall back to the folder dialog when the sidebar isn't on screen. */
export const ADD_PROJECT_EVENT = "aura:add-project";
export type AddProjectDetail = { handled: boolean };

/** Ask the sidebar for its add-project menu. True when something opened it. */
export function requestAddProject(target: EventTarget = window): boolean {
  const detail: AddProjectDetail = { handled: false };
  target.dispatchEvent(new CustomEvent<AddProjectDetail>(ADD_PROJECT_EVENT, { detail }));
  return detail.handled;
}
