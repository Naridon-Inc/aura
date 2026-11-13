// A cloud workspace's pull request: what the server reads from GitHub for the
// workspace's branch, and the toolbar state that reading means.
//
// The server reads it with the org's App installation, and opens or readies
// a pull request as the member who clicked, with the GitHub they connected in
// Settings → Git → Your GitHub. Nothing here holds a GitHub credential.
// Merging isn't offered from here: it happens on GitHub, as the person, under
// the repository's own rules about who may.

import { invoke } from "@tauri-apps/api/core";

import type { GitWorkflow } from "../components/ui/git-workflow";
import { myGithubRefusal } from "./cloudMyGithub";

export type CloudPullRequest = {
  number: number;
  title: string;
  url: string;
  /** `open` | `closed` | `merged`. */
  state: string;
  draft: boolean;
  /** GitHub's merge state, lower-cased: `clean`, `dirty`, `blocked`,
   *  `behind`, `unstable`, `has_hooks`, `draft` or `unknown`. */
  merge_state: string;
  review: "approved" | "changes_requested" | "review_required" | null;
  checks: { total: number; failing: number; pending: number } | null;
  base: string;
  head_sha: string | null;
};

export type CloudPullRequestRead = {
  branch: string | null;
  base: string | null;
  repo: string | null;
  reason: string | null;
  detail: string | null;
  compare_url: string | null;
  merge_method: "squash" | "merge" | "rebase" | null;
  pr: CloudPullRequest | null;
};

export const cloudPrApi = {
  read: (id: string, branch?: string | null) =>
    invoke<CloudPullRequestRead>("cloud_workspace_pull_request", { id, branch: branch ?? null }),
  create: (id: string, opts: { title?: string | null; draft: boolean; branch?: string | null }) =>
    invoke<CloudPullRequestRead>("cloud_workspace_pull_request_create", {
      id,
      title: opts.title ?? null,
      draft: opts.draft,
      branch: opts.branch ?? null,
    }),
  ready: (id: string, branch?: string | null) =>
    invoke<CloudPullRequestRead>("cloud_workspace_pull_request_ready", { id, branch: branch ?? null }),
};

const MERGE_WORDS: Record<string, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** Why there's no pull request to show, as the toolbar's issue popover says it. */
export function reasonIssue(
  reason: string,
  detail: string | null,
): { label: string; title: string; description: string; retry: boolean; settings?: boolean } | null {
  switch (reason) {
    case "github_not_connected":
      return {
        label: "Connect your GitHub",
        title: "Your GitHub isn’t connected",
        description: myGithubRefusal("github_not_connected", detail),
        retry: false,
        settings: true,
      };
    case "github_cannot_open":
      return {
        label: "Your GitHub can’t open this",
        title: "Your GitHub account can’t open this repository",
        description: myGithubRefusal("github_cannot_open", detail),
        retry: true,
      };
    case "no_branch":
      return {
        label: "No branch yet",
        title: "No branch to open a pull request from",
        description: "This workspace hasn’t recorded the branch it works on yet. Once the agent commits to one, its pull request shows here.",
        retry: true,
      };
    case "no_github":
      return {
        label: "Not on GitHub",
        title: "This repository isn’t on GitHub",
        description: "Pull requests are read from GitHub, and this workspace’s repository isn’t connected to it.",
        retry: false,
      };
    case "no_github_app":
      return {
        label: "GitHub not connected",
        title: "No connected GitHub account owns this repository",
        description:
          "An owner or admin connects the GitHub account or organization it lives in from Settings → Organization → Connected GitHub, then try again.",
        retry: true,
      };
    case "project_not_in_github_app":
      return {
        label: "GitHub can’t see this repository",
        title: "The Aura GitHub App can’t reach this repository",
        description:
          detail ?? "Add this repository to the Aura GitHub App’s repository access on GitHub, then try again.",
        retry: true,
      };
    case "github_refused":
      return {
        label: "PR status unavailable",
        title: "GitHub didn’t answer",
        description: detail ?? "GitHub couldn’t be asked about this branch’s pull request just now.",
        retry: true,
      };
    default:
      return null;
  }
}

/** What a failed create says, in a sentence for the notice bar. */
export function createRefusal(reason: string, detail: string | null): string {
  switch (reason) {
    case "no_commits":
      return "There’s nothing to open a pull request for: this branch has no commits its base doesn’t.";
    case "not_pushed":
      return "GitHub doesn’t have this branch yet. Push it, then create the pull request.";
    case "no_drafts":
      return "This repository doesn’t take draft pull requests. Create a regular one instead.";
    case "no_base":
      return detail ?? "There’s no branch to merge this one into.";
    case "already_open":
      return "A pull request is already open for this branch.";
    case "no_pr_permission":
      return "GitHub didn’t let you open a pull request on this repository: your account, or the Aura GitHub App, isn’t allowed to.";
    default:
      return reasonIssue(reason, detail)?.description ?? detail ?? "The pull request couldn’t be created.";
  }
}

/** Where the workspace's branch stands on the machine it runs on, when the
 *  panel can read it: commits GitHub doesn't have yet come before any PR. */
export type BranchStanding = { ahead: number; pushed: boolean } | null;

/**
 * The toolbar for one read. `read` null is the first read still out;
 * `failed` is a read that didn't answer at all (signed out, an older server).
 */
export function prWorkflow(
  read: CloudPullRequestRead | null,
  opts: { failed?: string | null; busy?: GitWorkflow["state"] | null; standing?: BranchStanding } = {},
): GitWorkflow {
  const base: GitWorkflow = {
    state: "loading",
    branch: read?.branch ?? undefined,
    targetBranch: read?.pr?.base || read?.base || undefined,
  };
  if (opts.busy) return { ...base, state: opts.busy };
  if (!read) {
    if (opts.failed)
      return {
        ...base,
        state: "no-pr",
        label: "PR status unavailable",
        warningTone: true,
        issue: { title: "Couldn’t read the pull request", description: opts.failed, action: "retry" },
      };
    return base;
  }
  if (read.reason) {
    const issue = reasonIssue(read.reason, read.detail);
    if (issue)
      return {
        ...base,
        state: "no-pr",
        label: issue.label,
        warningTone: read.reason !== "no_branch",
        issue: {
          title: issue.title,
          description: issue.description,
          action: issue.settings ? "open-settings" : issue.retry ? "retry" : undefined,
        },
      };
  }
  const pr = read.pr;
  const open = pr?.state === "open";
  const standing = opts.standing;
  // Work GitHub hasn't seen yet: a pull request opened now would miss it.
  if (standing && (!pr || open) && (!standing.pushed || standing.ahead > 0))
    return {
      ...base,
      state: "ahead",
      ahead: standing.pushed ? standing.ahead : undefined,
      label: standing.pushed ? undefined : "Not pushed",
      prNumber: pr?.number,
      prUrl: pr?.url,
    };
  if (!pr) return { ...base, state: "no-pr" };
  const withPr: GitWorkflow = { ...base, prNumber: pr.number, prUrl: pr.url };
  if (pr.state === "merged") return { ...withPr, state: "merged" };
  if (pr.state !== "open") return { ...withPr, state: "closed" };
  if (pr.draft) return { ...withPr, state: "draft" };
  if (pr.merge_state === "dirty") return { ...withPr, state: "conflicts" };
  const checks = pr.checks;
  if (checks && checks.failing > 0)
    return {
      ...withPr,
      state: "checks-failing",
      failedChecks: checks.failing,
      totalChecks: checks.total,
      hasFixableChecks: false,
      logsAvailable: false,
    };
  if (pr.review === "changes_requested")
    return { ...withPr, state: "changes-requested", hasPendingComments: false };
  if (checks && checks.pending > 0)
    return { ...withPr, state: "checks-pending", pendingChecks: checks.pending, totalChecks: checks.total, canAutoMerge: false };
  if (pr.merge_state === "unknown")
    return { ...withPr, state: "loading", label: "Checking whether it can merge…" };
  if (pr.merge_state === "behind")
    return {
      ...withPr,
      state: "blocked",
      label: `Out of date with ${pr.base || "its base"}`,
      detail: "Update the branch on GitHub before it can merge.",
    };
  if (pr.merge_state === "blocked")
    return pr.review === "review_required"
      ? { ...withPr, state: "review-required" }
      : { ...withPr, state: "blocked", detail: "The repository’s rules don’t let it merge yet." };
  const how = read.merge_method ? MERGE_WORDS[read.merge_method] : null;
  return {
    ...withPr,
    state: "ready",
    mergeTooltip: how ? `${how} on GitHub` : "Merge on GitHub",
  };
}
