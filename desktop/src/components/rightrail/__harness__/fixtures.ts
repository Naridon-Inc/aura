// What the Checks harness's stand-in commands answer: one repository, a few
// workspaces, and the pull requests GitHub would list for it.

import type { AheadBehind, PrCheck, PrComment, PrDetail, PrSummary, VercelDeployment } from "../../../lib/api";
import type { WorktreeRef } from "../../../lib/workspaceRef";

export const ROOT = "/Users/sam/code/aura";

const at = "2026-11-10T09:00:00Z";

export function pr(over: Partial<PrSummary> & Pick<PrSummary, "number" | "title" | "head_ref">): PrSummary {
  return {
    state: "OPEN",
    author: "sam",
    base_ref: "main",
    is_draft: false,
    additions: 120,
    deletions: 14,
    created_at: at,
    updated_at: at,
    review_decision: null,
    url: `https://github.com/acme/aura/pull/${over.number}`,
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
    is_cross_repository: false,
    head_repo_owner: "acme",
    ...over,
  };
}

export function detailOf(p: PrSummary, body: string, reviewers: PrDetail["reviewers"] = []): PrDetail {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    body,
    author: p.author,
    head_ref: p.head_ref,
    base_ref: p.base_ref,
    is_draft: p.is_draft,
    mergeable: "MERGEABLE",
    additions: p.additions,
    deletions: p.deletions,
    created_at: p.created_at,
    updated_at: p.updated_at,
    review_decision: p.review_decision,
    url: p.url,
    files: [],
    diff: "",
    aura_review: null,
    reviewers,
    assignees: [],
    merged_by: null,
    merged_at: null,
    related_issues: [],
  };
}

export function check(name: string, bucket: "success" | "failure" | "pending", workflow = "CI"): PrCheck {
  return {
    name,
    bucket,
    raw: bucket === "success" ? "SUCCESS" : bucket === "failure" ? "FAILURE" : "IN_PROGRESS",
    url: `https://github.com/acme/aura/actions/runs/1/job/${name.length}`,
    workflow,
    description: "",
    failure_reason: "",
  };
}

export function comment(id: number, author: string, body: string, path: string | null = null): PrComment {
  return {
    id,
    node_id: `c${id}`,
    author,
    body,
    created_at: at,
    updated_at: at,
    path,
    line: path ? 42 : null,
    start_line: null,
    side: path ? "RIGHT" : null,
    in_reply_to: null,
    is_issue_comment: path === null,
    thread_resolved: false,
    reactions: [],
  } as unknown as PrComment;
}

export function worktree(path: string, branch: string, isMain = false): WorktreeRef {
  return {
    path,
    branch,
    head: "abc1234",
    is_main: isMain,
    locked: false,
    head_committed_at: Math.floor(Date.parse(at) / 1000) - 3600,
    created_at: null,
  };
}

export type Scene = {
  branch: string;
  ab: AheadBehind;
  changed: number;
  prs: PrSummary[];
  details: Record<number, PrDetail>;
  checks: Record<number, PrCheck[]>;
  comments: Record<number, PrComment[]>;
  worktrees: WorktreeRef[];
  /** Commits the target branch has that this one doesn't. */
  targetBehind?: number;
  /** The pull request's preview deployment, when it has one. */
  deploy?: VercelDeployment;
  /** The Dashboard rather than the Checks tab. */
  dashboard?: boolean;
  /** Which Dashboard view opens. */
  view?: "workspaces" | "pulls";
};

const teammates = [
  pr({ number: 96, title: "Cloud runs for remote workspaces", head_ref: "feat/remote-runs", author: "riya", is_authored_by_me: false, is_review_requested_for_me: true, review_decision: "REVIEW_REQUIRED" }),
  pr({ number: 94, title: "Faster conversation saves", head_ref: "perf/chat-save", author: "lee", is_authored_by_me: false, checks_state: "failure", checks_failing: 1, checks_passing: 2 }),
  pr({ number: 91, title: "Sidebar padding", head_ref: "fix/sidebar-padding", state: "MERGED", author: "sam" }),
];

const checksPr = pr({
  number: 101,
  title: "Checks shows this workspace's pull request",
  head_ref: "feat/checks-one-pr",
  checks_state: "failure",
  checks_total: 4,
  checks_passing: 2,
  checks_failing: 1,
  checks_pending: 1,
  review_decision: "REVIEW_REQUIRED",
  additions: 412,
  deletions: 188,
});

const stackModel = pr({ number: 102, title: "Stack: the workspace model", head_ref: "feat/stack-model", additions: 80, deletions: 4 });
const stackApi = pr({ number: 103, title: "Stack: the API on top of the model", head_ref: "feat/stack-api", base_ref: "feat/stack-model", additions: 140, deletions: 22, checks_state: "pending", checks_pending: 1, checks_passing: 2 });
const stackUi = pr({ number: 104, title: "Stack: the screens", head_ref: "feat/stack-ui", base_ref: "feat/stack-api", author: "riya", is_authored_by_me: false });

const retryPr = pr({
  number: 105,
  title: "Uploads retry with backoff instead of failing the whole run",
  head_ref: "fix/upload-retry",
  checks_state: "failure",
  checks_total: 8,
  checks_passing: 4,
  checks_failing: 2,
  checks_pending: 2,
  review_decision: "CHANGES_REQUESTED",
  additions: 96,
  deletions: 31,
});

const worktrees = [
  worktree(ROOT, "main", true),
  worktree(`${ROOT}-wt/checks`, "feat/checks-one-pr"),
  worktree(`${ROOT}-wt/cloud`, "feat/cloud-remote"),
  worktree(`${ROOT}-wt/model`, "feat/stack-model"),
  worktree(`${ROOT}-wt/api`, "feat/stack-api"),
  worktree(`${ROOT}-wt/retry`, "fix/upload-retry"),
];

const all = [checksPr, stackModel, stackApi, stackUi, retryPr, ...teammates];

// GitHub markdown, as a description written by an agent reads: a heading,
// bold and code inside a list, a link and a table.
const description = [
  "## Summary",
  "",
  "The Checks tab is the home of this workspace's **pull request**.",
  "",
  "1. Shows the pull request's state, branch, reviewers and checks",
  "2. Lists the rest of the stack when the branch sits on `another-workspace`",
  "3. Moves the repository-wide list to the [Dashboard](https://example.dev/dashboard)",
  "",
  "## Test plan",
  "",
  "| Check | Result |",
  "| --- | --- |",
  "| `bun test` | 4436 pass |",
  "| `tsc --noEmit` | clean |",
].join("\n");

export const SCENES: Record<string, Scene> = {
  "no-pr": {
    branch: "feat/cloud-remote",
    ab: { ahead: 2, behind: 0, has_upstream: true, branch: "feat/cloud-remote" },
    changed: 3,
    prs: all,
    details: {},
    checks: {},
    comments: {},
    worktrees,
  },
  "open-pr": {
    branch: "feat/checks-one-pr",
    ab: { ahead: 0, behind: 0, has_upstream: true, branch: "feat/checks-one-pr" },
    changed: 2,
    targetBehind: 18,
    prs: all,
    details: {
      101: detailOf(checksPr, description, [
        { login: "riya", state: "COMMENTED" },
        { login: "lee", state: "PENDING" },
      ]),
    },
    checks: {
      101: [
        check("typecheck", "failure"),
        check("e2e (macos)", "pending"),
        check("unit", "success"),
        check("lint", "success"),
      ],
    },
    comments: {
      101: [comment(1, "riya", "Can the stack rows say which one is checked out here?", "aura-shell/src/components/rightrail/ChecksPanel.tsx")],
    },
    worktrees,
  },
  stacked: {
    branch: "feat/stack-api",
    ab: { ahead: 1, behind: 0, has_upstream: true, branch: "feat/stack-api" },
    changed: 0,
    prs: all,
    details: { 103: detailOf(stackApi, "The API layer, built on the model in #102.") },
    checks: { 103: [check("unit", "success"), check("lint", "success"), check("e2e (linux)", "pending")] },
    comments: {},
    worktrees,
  },
  failing: {
    branch: "fix/upload-retry",
    ab: { ahead: 0, behind: 1, has_upstream: true, branch: "fix/upload-retry" },
    changed: 0,
    prs: all,
    details: {
      105: detailOf(retryPr, "", [
        { login: "riya", state: "CHANGES_REQUESTED" },
        { login: "lee", state: "COMMENTED" },
      ]),
    },
    checks: {
      105: [
        check("typecheck", "failure"),
        check("unit (linux)", "failure"),
        check("e2e (macos)", "pending"),
        check("e2e (linux)", "pending"),
        check("lint", "success"),
        check("build", "success"),
        check("format", "success"),
        check("docs", "success"),
      ],
    },
    comments: {
      105: [
        comment(11, "riya", "Cap the backoff; a dead host shouldn't hold the run for minutes.", "aura-cloud/src/upload.rs"),
        comment(12, "riya", "Log which attempt finally went through.", "aura-cloud/src/upload.rs"),
        comment(13, "lee", "Is the retry count configurable per workspace?"),
      ],
    },
    deploy: {
      uid: "dpl_105",
      state: "READY",
      url: "aura-upload-retry.vercel.app",
      inspector_url: "https://vercel.com/acme/aura/dpl_105",
      target: null,
      created_at_ms: Date.parse(at),
    },
    worktrees,
  },
  dashboard: {
    branch: "main",
    ab: { ahead: 0, behind: 0, has_upstream: true, branch: "main" },
    changed: 0,
    prs: all,
    details: {},
    checks: {},
    comments: {},
    worktrees,
    dashboard: true,
  },
  "dashboard-prs": {
    branch: "main",
    ab: { ahead: 0, behind: 0, has_upstream: true, branch: "main" },
    changed: 0,
    prs: all,
    details: {},
    checks: {},
    comments: {},
    worktrees,
    dashboard: true,
    view: "pulls",
  },
};
