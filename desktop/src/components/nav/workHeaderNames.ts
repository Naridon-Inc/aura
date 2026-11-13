import type { WorktreeRef } from "../../lib/workspaceRef";
import { humanizeCopyTitle } from "../../lib/workspaceLabel";

/** What the work header calls the place you are in: the repository it belongs
 *  to, and the workspace inside it. `repo` is null when no repository in the
 *  sidebar lists this checkout — the header then names the workspace alone
 *  rather than printing one folder name twice. */
export type WorkHeaderNames = {
  repo: string | null;
  /** The sidebar's root for that repository, which keys its picture. */
  repoRoot: string | null;
  workspace: string;
};

const trim = (p: string) => p.replace(/\/+$/, "");
const leaf = (p: string) => trim(p).split("/").pop() || p;

/** Resolve the header's two names for the checkout at `root`.
 *
 *  A workspace is one checkout of a repository, so the repository is the
 *  roster group that lists it — not the checkout's own folder, which for a
 *  parallel copy is a generated directory name. The workspace name is the one
 *  the sidebar row shows: a name the user typed, else the humanised branch. */
export function workHeaderNames(
  root: string,
  fallbackName: string,
  worktreesByRoot: Record<string, WorktreeRef[]>,
): WorkHeaderNames {
  const here = trim(root);
  for (const [repoRoot, refs] of Object.entries(worktreesByRoot)) {
    const ref = refs.find((w) => trim(w.path) === here);
    if (!ref) continue;
    const main = refs.find((w) => w.is_main);
    return {
      repo: leaf(main?.path ?? repoRoot),
      repoRoot,
      workspace: humanizeCopyTitle(ref.branch, ref.is_main, ref.path),
    };
  }
  return { repo: null, repoRoot: null, workspace: fallbackName || leaf(root) };
}
