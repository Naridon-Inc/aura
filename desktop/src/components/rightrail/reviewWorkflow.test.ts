import { describe, expect, test } from "bun:test";

import type { PrMergeState } from "../../lib/branchSync";
import { deriveReviewState } from "./reviewState";
import {
  checksFailedLabel,
  checksPendingLabel,
  mergeMethodTooltip,
  optionalChecksLabel,
  workflowFor,
  type WorkflowPr,
} from "./reviewWorkflow";

const merge = (status: string, over: Partial<PrMergeState> = {}): PrMergeState => ({
  merge_state_status: status,
  mergeable: "MERGEABLE",
  base_ref: "main",
  merge_queue_state: null,
  ...over,
});

const openPr = (over: Partial<WorkflowPr> = {}): WorkflowPr => ({
  number: 7,
  url: "u",
  state: "OPEN",
  isDraft: false,
  baseRef: "main",
  reviewDecision: null,
  checks: null,
  ...over,
});

// A level branch with an open pull request: what's left is GitHub's say.
function flow(pr: WorkflowPr, status: string | null = "CLEAN", over: Partial<PrMergeState> = {}) {
  return workflowFor({
    review: deriveReviewState({
      known: true,
      ahead: 0,
      behind: 0,
      hasUpstream: true,
      changedCount: 0,
      conflictsCount: 0,
      pr: { number: pr.number, state: pr.state, reviewDecision: pr.reviewDecision ?? null },
      canMerge: true,
    }),
    pr,
    branch: "feat",
    ahead: 0,
    behind: 0,
    changedCount: 0,
    busy: null,
    merge: status ? merge(status, over) : null,
  });
}

describe("the header's pull request states, most urgent first", () => {
  test("conflicts with the base come before a review asking for changes", () => {
    expect(flow(openPr({ reviewDecision: "CHANGES_REQUESTED" }), "DIRTY").state).toBe("conflicts");
  });

  test("changes requested comes before draft and the checks", () => {
    const pr = openPr({
      isDraft: true,
      reviewDecision: "CHANGES_REQUESTED",
      checks: { total: 5, failing: 2, pending: 0 },
    });
    expect(flow(pr).state).toBe("changes-requested");
  });

  test("a draft stays a draft whatever its checks say", () => {
    expect(flow(openPr({ isDraft: true, checks: { total: 3, failing: 1, pending: 0 } })).state).toBe("draft");
  });

  test("failing checks are counted, with what is still running", () => {
    const w = flow(openPr({ checks: { total: 5, failing: 1, pending: 1 } }), "BLOCKED");
    expect(w.state).toBe("checks-failing");
    expect(w.label).toBe("1 / 5 checks failed, 1 pending");
    expect(w.failedChecks).toBe(1);
    expect(w.totalChecks).toBe(5);
  });

  test("running checks come after failed ones and before the review", () => {
    const w = flow(openPr({ reviewDecision: "REVIEW_REQUIRED", checks: { total: 4, failing: 0, pending: 3 } }));
    expect(w.state).toBe("checks-pending");
    expect(w.label).toBe("3 checks pending…");
  });

  test("optional checks failing leave the pull request mergeable", () => {
    const w = flow(openPr({ reviewDecision: "APPROVED", checks: { total: 4, failing: 2, pending: 0 } }), "UNSTABLE");
    expect(w.state).toBe("ready");
    expect(w.label).toBe("2 optional checks failed");
  });

  test("a review still owed, then anything else blocking", () => {
    expect(flow(openPr({ reviewDecision: "REVIEW_REQUIRED" })).state).toBe("review-required");
    expect(flow(openPr({ reviewDecision: "APPROVED" }), "BLOCKED").state).toBe("blocked");
  });

  test("a review owed that you can give asks you to approve", () => {
    const owed = openPr({ reviewDecision: "REVIEW_REQUIRED" });
    expect(flow(owed, "BLOCKED", { can_approve: true }).state).toBe("approve-pr");
    expect(flow(owed, "BLOCKED", { can_approve: false }).state).toBe("review-required");
    // Running checks still come first.
    const running = openPr({ reviewDecision: "REVIEW_REQUIRED", checks: { total: 2, failing: 0, pending: 1 } });
    expect(flow(running, "BLOCKED", { can_approve: true }).state).toBe("checks-pending");
  });

  test("passing checks and no merge state read yet is ready", () => {
    const w = flow(openPr({ reviewDecision: "APPROVED", checks: { total: 2, failing: 0, pending: 0 } }), null);
    expect(w.state).toBe("ready");
    expect(w.label).toBeUndefined();
  });

  test("a closed pull request is not asked about its checks", () => {
    const pr = openPr({ state: "CLOSED", checks: { total: 2, failing: 2, pending: 0 } });
    expect(flow(pr).state).not.toBe("checks-failing");
  });
});

describe("the Merge tooltip", () => {
  test("says how the repository merges", () => {
    expect(mergeMethodTooltip("squash")).toBe("Squash and merge");
    expect(mergeMethodTooltip("rebase")).toBe("Rebase and merge");
    expect(mergeMethodTooltip("merge")).toBeUndefined();
    // Unread: Merge squashes.
    expect(mergeMethodTooltip(null)).toBe("Squash and merge");
    const rebases = flow(openPr({ reviewDecision: "APPROVED" }), "CLEAN", { merge_method: "rebase" });
    expect(rebases.mergeTooltip).toBe("Rebase and merge");
  });
});

describe("the check labels", () => {
  test("failed, with and without checks still running", () => {
    expect(checksFailedLabel({ total: 5, failing: 2, pending: 0 })).toBe("2 / 5 checks failed");
    expect(checksFailedLabel({ total: 5, failing: 2, pending: 3 })).toBe("2 / 5 checks failed, 3 pending");
  });
  test("pending, one and many", () => {
    expect(checksPendingLabel(1)).toBe("1 check pending…");
    expect(checksPendingLabel(4)).toBe("4 checks pending…");
    expect(checksPendingLabel(0)).toBe("Checks pending…");
  });
  test("optional failures", () => {
    expect(optionalChecksLabel(1)).toBe("1 optional check failed");
    expect(optionalChecksLabel(0)).toBe("Optional checks failed");
  });
});
