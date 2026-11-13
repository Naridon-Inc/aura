// Turning what we know about a branch into the git status row's state.
//
// `deriveReviewState` decides WHERE the branch stands (its precedence is shared
// with the branch switcher, so both always agree). This maps that answer onto
// the status row's vocabulary, adding what the pull request itself says
// (draft, closed, changes requested, its checks) and which action is in
// flight. Pure, so it is tested
// without React.

import type { PrMergeState } from "../../lib/branchSync";
import type { GitWorkflow, GitWorkflowState } from "../ui/git-workflow";
import { mergeQueueText } from "./branchSyncRows";
import type { ReviewState } from "./reviewState";

/** Branches a pull request is opened INTO, never from. */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "develop", "trunk"]);

export type WorkflowPr = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  /** GitHub's review decision: changes requested, or a review still owed. */
  reviewDecision?: string | null;
  /** The pull request's checks, counted; null or absent when it has none. */
  checks?: WorkflowChecks | null;
};

export type WorkflowChecks = { total: number; failing: number; pending: number };

/** What is running right now, from a click here or a background job. */
export type WorkflowBusy = "pushing" | "pulling" | "merging" | "creating-pr" | "working" | null;

export function workflowFor({
  review,
  pr,
  branch,
  ahead,
  behind,
  changedCount,
  busy,
  merge = null,
}: {
  review: ReviewState;
  pr: WorkflowPr | null;
  branch: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  busy: WorkflowBusy;
  /** GitHub's merge state for the open pull request, once read. */
  merge?: PrMergeState | null;
}): GitWorkflow {
  const base: GitWorkflow = {
    state: "loading",
    prNumber: pr?.number,
    prUrl: pr?.url,
    branch: branch ?? undefined,
    targetBranch: pr?.baseRef || undefined,
    ahead,
    behind,
    changedFiles: changedCount,
    detail: review.detail,
    mergeTooltip: mergeMethodTooltip(merge?.merge_method),
  };
  if (busy) return { ...base, state: busy };
  let state = stateFor(review, pr);
  // Behind its remote AND ahead of it: the two went separate ways. Behind
  // alone still outranks "ready": the remote has commits the PR will carry.
  if (state === "behind" && ahead > 0) return { ...base, state: "diverged" };
  if (state === "ready" && behind > 0) state = "behind";
  const open = pr != null && pr.state.toLowerCase() === "open";
  if (!pr || !open) return { ...base, state };
  // What only GitHub knows, in this order: the queue right after
  // merged, then — once the branch is level — conflicts with the base, the
  // review, draft, the checks, and what else blocks the merge.
  if (merge?.merge_queue_state && state !== "loading" && state !== "conflicts") {
    return { ...base, state: "queued", label: mergeQueueText(merge.merge_queue_state) };
  }
  if (state !== "ready" && state !== "draft") return { ...base, state };
  return { ...base, ...openPrState(state === "draft", pr, merge) };
}

/** An open pull request on a level branch. Optional checks failing don't hold
 *  a merge GitHub allows (UNSTABLE), so they only change the ready label. */
function openPrState(
  draft: boolean,
  pr: WorkflowPr,
  merge: PrMergeState | null,
): Pick<GitWorkflow, "state" | "label" | "failedChecks" | "totalChecks" | "pendingChecks"> {
  const status = merge?.merge_state_status;
  if (status === "DIRTY") return { state: "conflicts" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { state: "changes-requested" };
  if (draft) return { state: "draft" };
  const checks = pr.checks && pr.checks.total > 0 ? pr.checks : null;
  const optionalOnly = status === "UNSTABLE" && (checks?.failing ?? 0) > 0;
  if (checks && !optionalOnly) {
    if (checks.failing > 0) {
      return {
        state: "checks-failing",
        label: checksFailedLabel(checks),
        failedChecks: checks.failing,
        totalChecks: checks.total,
        pendingChecks: checks.pending,
      };
    }
    if (checks.pending > 0) {
      return { state: "checks-pending", label: checksPendingLabel(checks.pending), pendingChecks: checks.pending };
    }
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { state: merge?.can_approve ? "approve-pr" : "review-required" };
  }
  if (status === "BLOCKED") return { state: "blocked" };
  if (optionalOnly && checks) return { state: "ready", label: optionalChecksLabel(checks.failing) };
  return { state: "ready" };
}

/** What Merge does, over its button. Unread merges squash, so say so; a
 *  merge commit is just "Merge". */
export function mergeMethodTooltip(method: PrMergeState["merge_method"]): string | undefined {
  if (method === "merge") return undefined;
  return method === "rebase" ? "Rebase and merge" : "Squash and merge";
}

export function checksFailedLabel(c: WorkflowChecks): string {
  return `${c.failing} / ${c.total} checks failed` + (c.pending > 0 ? `, ${c.pending} pending` : "");
}

export function checksPendingLabel(pending: number): string {
  return pending > 0 ? `${pending} check${pending === 1 ? "" : "s"} pending…` : "Checks pending…";
}

export function optionalChecksLabel(failing: number): string {
  return failing === 0 ? "Optional checks failed" : `${failing} optional check${failing === 1 ? "" : "s"} failed`;
}

function stateFor(review: ReviewState, pr: WorkflowPr | null): GitWorkflowState {
  const closed = pr != null && pr.state.toLowerCase() === "closed";
  switch (review.id) {
    case "unknown":
      return "loading";
    case "conflicts":
      return "conflicts";
    case "merged":
      return "merged";
    case "ready":
      return pr?.isDraft ? "draft" : "ready";
    case "behind":
      return "behind";
    case "ahead":
      return "ahead";
    case "uncommitted":
      return "uncommitted";
    case "unpublished":
      // A pull request already exists, so the branch only needs pushing.
      return pr && !closed ? "ahead" : "no-pr";
    case "clean":
      return closed ? "closed" : "no-pr";
  }
}

/** Whether "Create PR" can do anything from this branch. */
export function canOpenPr(branch: string | null): boolean {
  return !!branch && !DEFAULT_BRANCHES.has(branch);
}
