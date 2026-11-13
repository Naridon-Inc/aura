// Which pull requests already have a workspace on this computer. One
// workspace is one branch, so a pull request's workspace is the checkout
// standing on its head branch; a fork's pull request is fetched into
// `pr-<n>-<branch>` (see lib/prStartPoint), so that is the branch it is
// looked for under. PURE, so it is unit tested.

import type { PrSummary } from "../../lib/api";
import { forkPrLocalBranch } from "../../lib/prStartPoint";

type PrKeys = Pick<PrSummary, "number" | "head_ref" | "is_cross_repository">;

/** The local branch a pull request's workspace stands on. */
export function prLocalBranch(pr: PrKeys): string {
  return pr.is_cross_repository ? forkPrLocalBranch(pr) : pr.head_ref;
}

/** Pull request number → the path of the checkout on its branch. A pull
 *  request with none is absent. */
export function prWorkspaces(
  prs: PrKeys[],
  worktrees: { path: string; branch: string }[],
): Map<number, string> {
  const byBranch = new Map<string, string>();
  for (const w of worktrees) {
    const b = w.branch.replace(/^refs\/heads\//, "");
    if (b && !byBranch.has(b)) byBranch.set(b, w.path);
  }
  const out = new Map<number, string>();
  for (const pr of prs) {
    const path = byBranch.get(prLocalBranch(pr));
    if (path) out.set(pr.number, path);
  }
  return out;
}
