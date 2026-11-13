// What the Checks tab says about the workspace's pull request beside its
// title: who is reviewing it and what stands between it and a merge. PURE —
// the panel hands in what it read, so a test can too.

import type { PrCheck, PrComment, PrDetail, PrStackNode, PrSummary } from "../../lib/api";
import { GIT_WORKFLOW_LABELS } from "../ui/git-workflow";
import { bucketOf } from "../pr/checks/PrCheckRows";
import { prWorkflow, reviewerLabel, type PrChecksTally } from "../pr/overview/prOverviewModel";

/** The pull request's check counts: the run list once it is read (it is the
 *  fresher of the two), GitHub's roll-up on the summary until then. */
export function checksTally(pr: PrSummary, read: PrCheck[] | null): PrChecksTally {
  if (read) {
    const failing = read.filter((c) => bucketOf(c) === "failure").length;
    const pending = read.filter((c) => bucketOf(c) === "pending").length;
    return {
      state: failing ? "failure" : pending ? "pending" : read.length ? "success" : null,
      passing: read.length - failing - pending,
      failing,
      pending,
      total: read.length,
    };
  }
  return {
    state: pr.checks_state,
    passing: pr.checks_passing,
    failing: pr.checks_failing,
    pending: pr.checks_pending,
    total: pr.checks_total,
  };
}

/** "riya (commented), lee" — or nobody yet. */
export function reviewersLine(detail: PrDetail | null): string | null {
  if (!detail) return null;
  return detail.reviewers.length ? detail.reviewers.map(reviewerLabel).join(", ") : "No reviewers";
}

/** What stands between the pull request and a merge, in the words the full
 *  pull request tab uses for it. `canMerge` is the tab's own reading of the
 *  branch (pushed, nothing uncommitted, GitHub agreeing): GitHub alone calling
 *  it ready isn't enough to offer Merge here. */
export function mergeLine(
  detail: PrDetail | null,
  tally: PrChecksTally,
  comments: PrComment[],
  canMerge: boolean,
): string {
  if (canMerge) return GIT_WORKFLOW_LABELS.ready;
  if (!detail) return GIT_WORKFLOW_LABELS.loading;
  const state = prWorkflow(detail, tally, "", comments).state;
  // Ready by GitHub, held back here: the branch is what's in the way, and
  // Git status below says how.
  if (state === "ready") return "Ready once the branch is in step";
  return GIT_WORKFLOW_LABELS[state];
}

/** "On #98", or what is built on this one when nothing is under it. */
export function stackLine(nodes: PrStackNode[], prNumber: number): string | null {
  if (nodes.length <= 1) return null;
  const here = nodes.find((n) => n.number === prNumber);
  if (!here) return null;
  if (here.parent !== null) return `On #${here.parent}`;
  if (here.children.length === 1) return `#${here.children[0]} builds on this`;
  if (here.children.length > 1) return `${here.children.length} pull requests build on this`;
  return null;
}
