// The words and the gates for the Git status rows that need GitHub's merge
// state or the branch's distance from its target: the merge queue, a pull
// request GitHub can't merge for conflicts, a branch that went one way while
// its remote went another, and "N commits behind main".
//
// Titles keep the plain words the other rows use; the hover carries GitHub's
// and git's exact terms. Pure, so the gates are tested without React.

import { countOf } from "@shared/plural";

import type { AheadBehind } from "../../lib/api";
import type { MergeQueueState, PrMergeState, TargetSync } from "../../lib/branchSync";

/** What the merge queue says about the pull request, in GitHub's words. */
export function mergeQueueText(state: MergeQueueState): string {
  switch (state) {
    case "AWAITING_CHECKS":
      return "Merge queue checks pending";
    case "UNMERGEABLE":
      return "Merge queue blocked";
    case "LOCKED":
      return "Merge queue locked";
    case "MERGEABLE":
    case "QUEUED":
      return "Queued to merge";
  }
}

/** The queue page for the base branch, from the pull request's own URL. */
export function mergeQueueUrl(prUrl: string, baseRef: string): string {
  return `${prUrl.replace(/\/pull\/\d+$/, "")}/queue/${baseRef}`;
}

/** The branch and its upstream each hold commits the other doesn't. */
export function isIncompatible(ab: AheadBehind | null): boolean {
  return !!ab && ab.has_upstream && ab.ahead > 0 && ab.behind > 0;
}

/** GitHub can't merge the pull request because it conflicts with its base. */
export function hasTargetConflicts(merge: PrMergeState | null): boolean {
  return merge?.merge_state_status === "DIRTY";
}

/** GitHub lets the pull request in as it stands (UNSTABLE: only optional
 *  checks are failing). Unknown when the merge state hasn't been read. */
export function mergeStateAllows(merge: PrMergeState | null): boolean | null {
  if (!merge?.merge_state_status) return null;
  return merge.merge_state_status === "CLEAN" || merge.merge_state_status === "UNSTABLE";
}

export type PullLatestInput = {
  sync: TargetSync | null;
  merge: PrMergeState | null;
  ab: AheadBehind | null;
  /** The pull request is merged. */
  merged: boolean;
};

/** Whether to offer pulling the target in: the branch is missing target
 *  commits, isn't waiting on its own remote, and nothing else (a merge, the
 *  queue, a conflict GitHub already reports) has the row. */
export function showPullLatest({ sync, merge, ab, merged }: PullLatestInput): boolean {
  if (!sync || sync.behind <= 0 || merged) return false;
  if (merge?.merge_queue_state) return false;
  if (hasTargetConflicts(merge)) return false;
  if (ab && ab.behind > 0) return false;
  return true;
}

export const INCOMPATIBLE_TITLE = "You and the team both changed this branch";
export const INCOMPATIBLE_HINT =
  "Incompatible with remote: this branch and its copy on the remote each have commits the other doesn't. Aura brings them together so one push carries both.";

export const TARGET_CONFLICTS_HINT = (target: string) =>
  `Merge conflicts detected: GitHub can't merge this pull request into ${target} until the lines both sides changed are settled. Aura merges ${target} in, resolves them, then commits and pushes.`;

export function pullLatestTitle(sync: TargetSync): string {
  return `Missing ${countOf(sync.behind, "update")} from ${sync.target}`;
}

export function pullLatestHint(sync: TargetSync): string {
  const n = sync.behind;
  return `${n} commit${n === 1 ? "" : "s"} behind ${sync.target}: work has landed on ${sync.target} since this branch started. Pull brings it in, straight away when nothing here is in the way, through Aura when it needs a merge.`;
}
