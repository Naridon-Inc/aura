import { describe, expect, test } from "bun:test";

import type { PrSummary } from "../../lib/api";
import type { CloudJobWithRoot } from "../../lib/useCloudJobs";
import { groupCloudThreads } from "../../lib/cloudJobs";
import type { WorkspaceCopy } from "./workspacesModel";
import {
  CLOUD_ROW_PREFIX,
  cloudThreadOverview,
  cloudThreadsOffDisk,
  copyOverview,
  copyPr,
  copyStage,
  copyWorkflow,
} from "./workspacesOverview";

// A Workspaces row says where a copy stands and offers the one next step.
// Both have to come from what git and GitHub actually said, in the order the
// review pane uses, or the row and the pane argue about the same branch.

const NOW = 1_700_000_000_000;

function copy(over: Partial<WorkspaceCopy> = {}): WorkspaceCopy {
  return {
    path: "/repo/wt",
    root: "/repo",
    projectName: "repo",
    projectLetter: "R",
    branch: "feat/thing",
    title: "thing",
    isMain: false,
    isActive: false,
    committedAt: 1_699_999_000,
    createdAt: null,
    added: 0,
    removed: 0,
    changedFiles: 0,
    agents: [],
    ...over,
  };
}

function pr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 7,
    title: "Retry with backoff",
    state: "OPEN",
    author: "me",
    head_ref: "feat/thing",
    base_ref: "main",
    is_draft: false,
    additions: 1,
    deletions: 1,
    created_at: "",
    updated_at: "",
    review_decision: null,
    url: "https://github.com/o/r/pull/7",
    aura_risk_score: null,
    aura_risk_label: null,
    checks_state: "success",
    checks_total: 3,
    checks_passing: 3,
    checks_failing: 0,
    checks_pending: 0,
    is_authored_by_me: true,
    is_review_requested_for_me: false,
    labels: [],
    ...over,
  } as PrSummary;
}

const SYNCED = { ahead: 0, behind: 0, hasUpstream: true };

describe("where a copy stands", () => {
  test("a landed PR is done and a closed one is canceled", () => {
    const c = copy();
    expect(copyStage(copyPr(c, pr({ state: "MERGED" })))).toBe("done");
    expect(copyStage(copyPr(c, pr({ state: "CLOSED" })))).toBe("canceled");
  });

  test("an open PR is in review; a copy with no PR is in progress, busy or not", () => {
    const c = copy();
    expect(copyStage(copyPr(c, pr()))).toBe("in-review");
    expect(copyStage(copyPr(copy({ added: 3 }), null))).toBe("in-progress");
    expect(copyStage(copyPr(c, null))).toBe("in-progress");
  });

  test("the badge's PR stands in until the PR list is read", () => {
    const c = copy({ pr: { number: 4, state: "MERGED" } });
    expect(copyPr(c, null)).toEqual({ number: 4, state: "merged" });
    expect(copyStage(copyPr(c, null))).toBe("done");
  });
});

describe("the next git step", () => {
  test("someone working on it beats everything", () => {
    const c = copy({
      added: 5,
      agents: [{ agentId: "claude", label: "Claude Code", attention: false }],
    });
    expect(copyWorkflow(c, null, SYNCED).state).toBe("working");
  });

  test("an agent waiting on you is not drawn as working", () => {
    const c = copy({ added: 5, agents: [{ agentId: "claude", label: "Claude", attention: true }] });
    expect(copyWorkflow(c, null, SYNCED).state).toBe("uncommitted");
  });

  test("uncommitted, then behind, then diverged", () => {
    expect(copyWorkflow(copy({ changedFiles: 1 }), null, SYNCED).state).toBe("uncommitted");
    expect(copyWorkflow(copy(), null, { ...SYNCED, behind: 2 }).state).toBe("behind");
    expect(copyWorkflow(copy(), null, { ahead: 1, behind: 2, hasUpstream: true }).state).toBe(
      "diverged",
    );
  });

  test("commits with no PR offer one, except on the main checkout", () => {
    expect(copyWorkflow(copy(), null, { ...SYNCED, ahead: 3 }).state).toBe("no-pr");
    expect(copyWorkflow(copy({ isMain: true }), null, { ...SYNCED, ahead: 3 }).state).not.toBe(
      "no-pr",
    );
  });

  test("an open PR reads its own state", () => {
    const c = copy();
    const at = (p: PrSummary) => copyWorkflow(c, copyPr(c, p), SYNCED);
    expect(at(pr({ is_draft: true })).state).toBe("draft");
    expect(at(pr({ checks_state: "failure", checks_failing: 1 })).state).toBe("checks-failing");
    expect(at(pr({ review_decision: "CHANGES_REQUESTED" })).state).toBe("changes-requested");
    expect(at(pr({ checks_state: "pending" })).state).toBe("checks-pending");
    expect(at(pr({ review_decision: "APPROVED" })).state).toBe("ready");
    expect(at(pr()).state).toBe("review-required");
    expect(at(pr()).prUrl).toBe("https://github.com/o/r/pull/7");
  });

  test("unpushed commits on an open PR ask for a push first", () => {
    const c = copy();
    expect(copyWorkflow(c, copyPr(c, pr()), { ...SYNCED, ahead: 1 }).state).toBe("ahead");
  });

  test("git not read yet offers nothing", () => {
    expect(copyWorkflow(copy(), null, undefined).state).toBe("loading");
  });

  test("the app never offers what it cannot do for a PR", () => {
    const w = copyWorkflow(copy(), null, SYNCED);
    expect(w.hasFixableChecks).toBe(false);
    expect(w.hasPendingComments).toBe(false);
    expect(w.canAutoMerge).toBe(false);
  });
});

describe("a row", () => {
  test("line counts appear only when there is a diff", () => {
    const base = { nowMs: NOW, pr: null, git: SYNCED, archived: false };
    expect(copyOverview({ ...base, copy: copy() }).added).toBeUndefined();
    const dirty = copyOverview({ ...base, copy: copy({ added: 4, removed: 1, changedFiles: 1 }) });
    expect([dirty.added, dirty.removed]).toEqual([4, 1]);
  });

  test("carries the repository, the archive flag and a relative time", () => {
    const row = copyOverview({ copy: copy(), nowMs: NOW, pr: null, git: SYNCED, archived: true });
    expect(row.project).toBe("repo");
    expect(row.projectId).toBe("/repo");
    expect(row.archived).toBe(true);
    expect(row.timeLabel).not.toBe("");
  });

  test("the PR's title is the summary when nobody is on it", () => {
    const row = copyOverview({ copy: copy(), nowMs: NOW, pr: pr(), git: SYNCED, archived: false });
    expect(row.summary).toBe("Retry with backoff");
  });
});

function job(over: Partial<CloudJobWithRoot> = {}): CloudJobWithRoot {
  return {
    id: "j1",
    status: "working",
    agent: "claude",
    branch: null,
    text: "Fix the flaky test\nmore detail",
    error_message: null,
    commit_sha: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    context_id: null,
    repo: "owner/aura",
    result: null,
    repoRoot: "/repo",
    ...over,
  };
}

describe("work on another machine", () => {
  test("is a row named by its first line, in its repository", () => {
    const [thread] = groupCloudThreads([job()]);
    const row = cloudThreadOverview(thread!, NOW, false);
    expect(row.id.startsWith(CLOUD_ROW_PREFIX)).toBe(true);
    expect(row.title).toBe("Fix the flaky test");
    expect(row.project).toBe("aura");
    expect(row.workflow.state).toBe("working");
    expect(row.stage).toBe("in-progress");
  });

  test("finished, failed and queued read as done, canceled and backlog", () => {
    const stageOf = (status: string) =>
      cloudThreadOverview(groupCloudThreads([job({ status })])[0]!, NOW, false).stage;
    expect(stageOf("completed")).toBe("done");
    expect(stageOf("failed")).toBe("canceled");
    expect(stageOf("submitted")).toBe("backlog");
  });

  test("a failure says why", () => {
    const [thread] = groupCloudThreads([job({ status: "failed", error_message: "not signed in" })]);
    expect(cloudThreadOverview(thread!, NOW, false).summary).toBe("Failed: not signed in");
  });

  test("is left out when a copy on this disk already holds its branch", () => {
    const threads = groupCloudThreads([job({ branch: "feat/thing" }), job({ id: "j2", context_id: "x", branch: "feat/other" })]);
    const kept = cloudThreadsOffDisk(threads, [copy()]);
    expect(kept.map((t) => t.latest.branch)).toEqual(["feat/other"]);
  });
});
