import { describe, expect, test } from "bun:test";

import type { AheadBehind, PrSummary } from "../../lib/api";
import type { PrMergeState, TargetSync } from "../../lib/branchSync";
import { gitChatFor } from "../../lib/gitChatPrompts";
import {
  isIncompatible,
  mergeQueueText,
  mergeQueueUrl,
  mergeStateAllows,
  pullLatestHint,
  pullLatestTitle,
  showPullLatest,
} from "./branchSyncRows";
import { readyToMerge } from "./ChecksStatus";
import { pullLatestFromTarget, type PullLatestDeps } from "./pullLatest";
import { deriveReviewState } from "./reviewState";
import { workflowFor, type WorkflowPr } from "./reviewWorkflow";

const ab = (ahead: number, behind: number, has_upstream = true): AheadBehind =>
  ({ ahead, behind, has_upstream, branch: "feat" }) as AheadBehind;
const merge = (over: Partial<PrMergeState> = {}): PrMergeState => ({
  merge_state_status: "CLEAN",
  mergeable: "MERGEABLE",
  base_ref: "main",
  merge_queue_state: null,
  ...over,
});
const sync = (behind: number, ahead = 0): TargetSync => ({
  remote: "origin",
  target: "main",
  target_ref: "refs/remotes/origin/main",
  ahead,
  behind,
});

describe("merge queue", () => {
  test("each queue state reads in GitHub's words", () => {
    expect(mergeQueueText("AWAITING_CHECKS")).toBe("Merge queue checks pending");
    expect(mergeQueueText("UNMERGEABLE")).toBe("Merge queue blocked");
    expect(mergeQueueText("LOCKED")).toBe("Merge queue locked");
    expect(mergeQueueText("QUEUED")).toBe("Queued to merge");
    expect(mergeQueueText("MERGEABLE")).toBe("Queued to merge");
  });

  test("the queue page hangs off the repository, per base branch", () => {
    expect(mergeQueueUrl("https://github.com/acme/app/pull/12", "main")).toBe(
      "https://github.com/acme/app/queue/main",
    );
  });
});

describe("incompatible with remote", () => {
  test("only a branch both ahead of and behind its upstream", () => {
    expect(isIncompatible(ab(1, 1))).toBe(true);
    expect(isIncompatible(ab(2, 0))).toBe(false);
    expect(isIncompatible(ab(0, 3))).toBe(false);
    expect(isIncompatible(ab(1, 1, false))).toBe(false);
    expect(isIncompatible(null)).toBe(false);
  });
});

describe("behind the target branch", () => {
  test("offered when the target moved on and nothing else has the row", () => {
    expect(showPullLatest({ sync: sync(4), merge: null, ab: ab(0, 0), merged: false })).toBe(true);
    expect(showPullLatest({ sync: sync(0), merge: null, ab: ab(0, 0), merged: false })).toBe(false);
    expect(showPullLatest({ sync: null, merge: null, ab: ab(0, 0), merged: false })).toBe(false);
    expect(showPullLatest({ sync: sync(4), merge: null, ab: ab(0, 0), merged: true })).toBe(false);
    expect(showPullLatest({ sync: sync(4), merge: null, ab: ab(0, 2), merged: false })).toBe(false);
    expect(
      showPullLatest({ sync: sync(4), merge: merge({ merge_state_status: "DIRTY" }), ab: ab(0, 0), merged: false }),
    ).toBe(false);
    expect(
      showPullLatest({ sync: sync(4), merge: merge({ merge_queue_state: "QUEUED" }), ab: ab(0, 0), merged: false }),
    ).toBe(false);
  });

  test("plain title, git's count on hover", () => {
    expect(pullLatestTitle(sync(1))).toBe("Missing 1 update from main");
    expect(pullLatestTitle(sync(4))).toBe("Missing 4 updates from main");
    expect(pullLatestHint(sync(1)).startsWith("1 commit behind main")).toBe(true);
    expect(pullLatestHint(sync(4)).startsWith("4 commits behind main")).toBe(true);
  });
});

describe("ready to merge, once GitHub's merge state is read", () => {
  const pr = { number: 7, state: "OPEN", is_draft: false, review_decision: "APPROVED", checks_failing: 0, checks_pending: 0 } as PrSummary;
  test("CLEAN and UNSTABLE let it in; DIRTY, BLOCKED, BEHIND and a queue don't", () => {
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge())).toBe(true);
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge({ merge_state_status: "UNSTABLE" }))).toBe(true);
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge({ merge_state_status: "DIRTY" }))).toBe(false);
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge({ merge_state_status: "BLOCKED" }))).toBe(false);
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge({ merge_state_status: "BEHIND" }))).toBe(false);
    expect(readyToMerge(pr, ab(0, 0), 0, 0, merge({ merge_queue_state: "QUEUED" }))).toBe(false);
    expect(mergeStateAllows(null)).toBeNull();
  });
});

describe("the header with GitHub's merge state", () => {
  const openPr: WorkflowPr = { number: 7, url: "u", state: "OPEN", isDraft: false, baseRef: "main", reviewDecision: "APPROVED" };
  const flow = (a: AheadBehind, m: PrMergeState | null, pr: WorkflowPr | null = openPr) =>
    workflowFor({
      review: deriveReviewState({
        known: true,
        ahead: a.ahead,
        behind: a.behind,
        hasUpstream: a.has_upstream,
        changedCount: 0,
        conflictsCount: 0,
        pr: pr ? { number: pr.number, state: pr.state, reviewDecision: pr.reviewDecision ?? null } : null,
        canMerge: true,
      }),
      pr,
      branch: "feat",
      ahead: a.ahead,
      behind: a.behind,
      changedCount: 0,
      busy: null,
      merge: m,
    });

  test("a level branch whose PR conflicts with its base shows the conflicts", () => {
    expect(flow(ab(0, 0), merge({ merge_state_status: "DIRTY" })).state).toBe("conflicts");
  });
  test("a queued PR names the queue's state", () => {
    const w = flow(ab(0, 0), merge({ merge_queue_state: "AWAITING_CHECKS" }));
    expect(w.state).toBe("queued");
    expect(w.label).toBe("Merge queue checks pending");
  });
  test("blocked says why when a review is what's missing", () => {
    expect(flow(ab(0, 0), merge({ merge_state_status: "BLOCKED" })).state).toBe("blocked");
    expect(
      flow(ab(0, 0), merge({ merge_state_status: "BLOCKED" }), { ...openPr, reviewDecision: "REVIEW_REQUIRED" }).state,
    ).not.toBe("ready");
  });
  test("behind and ahead of the remote at once is incompatible, PR or not", () => {
    expect(flow(ab(1, 2), null, null).state).toBe("diverged");
    expect(flow(ab(1, 2), merge()).state).toBe("diverged");
    expect(flow(ab(0, 2), merge()).state).toBe("behind");
  });
  test("with nothing read from GitHub the header is as before", () => {
    expect(flow(ab(0, 0), null).state).toBe("ready");
  });
});

describe("Pull on the behind-target row", () => {
  const deps = (over: Partial<PullLatestDeps> & { after?: TargetSync | null } = {}) => {
    const calls: string[] = [];
    const d: PullLatestDeps = {
      fetch: async () => void calls.push("fetch"),
      sync: async () => (over.after === undefined ? sync(4) : over.after),
      fastForward: async (ref) => void calls.push(`ff:${ref}`),
      startChat: (req) => void calls.push(`chat:${gitChatFor(req).text}`),
      changedCount: async () => 0,
      ...over,
    };
    return { d, calls };
  };

  test("a target that only moved ahead fast-forwards here", async () => {
    const { d, calls } = deps();
    expect(await pullLatestFromTarget(sync(4), d)).toBe("fast-forwarded");
    expect(calls).toEqual(["fetch", "ff:refs/remotes/origin/main"]);
  });
  test("work on both sides opens a chat that merges", async () => {
    const { d, calls } = deps({ after: sync(4, 2) });
    expect(await pullLatestFromTarget(sync(4), d)).toBe("handed-to-chat");
    expect(calls).toEqual(["fetch", "chat:Merge origin/main into this branch. Then push."]);
  });
  test("uncommitted files open the chat before anything is fetched", async () => {
    const { d, calls } = deps({ changedCount: async () => 3 });
    expect(await pullLatestFromTarget(sync(4), d)).toBe("handed-to-chat");
    expect(calls).toEqual(["chat:Commit uncommitted changes, then merge origin/main into this branch. Then push."]);
  });
  test("already level after the fetch does nothing", async () => {
    const { d, calls } = deps({ after: sync(0, 0) });
    expect(await pullLatestFromTarget(sync(4), d)).toBe("up-to-date");
    expect(calls).toEqual(["fetch"]);
  });
  test("a target that vanished says so", async () => {
    const { d } = deps({ after: null });
    await expect(pullLatestFromTarget(sync(4), d)).rejects.toThrow("Target branch main does not exist");
  });
  test("a failed fetch names itself", async () => {
    const { d } = deps({ fetch: async () => Promise.reject(new Error("no network")) });
    await expect(pullLatestFromTarget(sync(4), d)).rejects.toThrow("Failed to fetch from remote: no network");
  });
});
