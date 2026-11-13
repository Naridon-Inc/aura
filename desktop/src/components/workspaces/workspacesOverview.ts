// The Workspaces page draws every copy as one `WorkspaceOverview` row. This is
// the one place that decides what each field of that row says, from facts the
// app has actually read: the checkout list, its diff badge, ahead/behind from
// git, the pull request from GitHub, the agents standing in it, and the cloud
// work sent from it. A field nobody has read stays empty rather than guessed —
// a row with no line counts is honest, a row reading "+0 −0" before git has
// answered is not.

import type {
  GitWorkflow,
  GitWorkflowState,
} from "../ui/git-workflow";
import type {
  WorkspaceOverview,
  WorkspaceStage,
} from "../ui/workspace-preview-card";
import type { PrSummary } from "../../lib/api";
import type { CloudJobWithRoot } from "../../lib/useCloudJobs";
import {
  cloudStatusLine,
  isCloudJobStranded,
  projectLabel,
  type CloudThread,
} from "../../lib/cloudJobs";
import { isCloudJobRunning } from "../../lib/useCloudJobs";
import { relTime, type WorkspaceCopy } from "./workspacesModel";

/** What git said about a copy's branch against its upstream. */
export type FleetGit = { ahead: number; behind: number; hasUpstream: boolean };

/** Rows for cloud conversations carry this in their id, so a click can tell a
 *  conversation on a machine from a checkout on this disk. */
export const CLOUD_ROW_PREFIX = "cloud:";

/** The pull request a copy is about, in the shape the row needs. The rich
 *  record from the PR list wins; the badge's number + state is the fallback
 *  for a repo whose PR list has not been read yet. */
export type CopyPr = {
  number: number;
  state: string;
  url?: string;
  title?: string;
  draft?: boolean;
  reviewDecision?: string | null;
  checksState?: string | null;
  checksTotal?: number;
  checksFailing?: number;
  checksPending?: number;
};

export function copyPr(
  copy: WorkspaceCopy,
  rich: PrSummary | null | undefined,
): CopyPr | null {
  if (rich) {
    return {
      number: rich.number,
      state: rich.state.toLowerCase(),
      url: rich.url,
      title: rich.title,
      draft: rich.is_draft,
      reviewDecision: rich.review_decision,
      checksState: rich.checks_state,
      checksTotal: rich.checks_total,
      checksFailing: rich.checks_failing,
      checksPending: rich.checks_pending,
    };
  }
  if (copy.pr) return { number: copy.pr.number, state: copy.pr.state.toLowerCase() };
  return null;
}

function hasDiff(copy: WorkspaceCopy): boolean {
  return copy.added > 0 || copy.removed > 0 || copy.changedFiles > 0;
}

function cloudRunning(copy: WorkspaceCopy): boolean {
  return !!copy.cloud && copy.cloud.status !== "submitted";
}

/** Where the work stands, read off its pull request alone: a closed PR went
 *  nowhere, a merged one is done, an open one is in review, and a copy with no
 *  PR is in progress. Nothing lands in Backlog by itself — that column is for
 *  the cards you put there (see lib/workspaceStage). */
export function copyStage(pr: CopyPr | null): WorkspaceStage {
  if (pr?.state === "closed") return "canceled";
  if (pr) return pr.state === "merged" ? "done" : "in-review";
  return "in-progress";
}

/** The next git step for a copy, most urgent first — the same order the
 *  review header uses, so the row and the review pane never disagree:
 *  someone working → landed/closed → uncommitted → behind/diverged → unpushed
 *  commits → the open PR's own state → a PR worth opening. */
export function copyWorkflow(
  copy: WorkspaceCopy,
  pr: CopyPr | null,
  git: FleetGit | null | undefined,
): GitWorkflow {
  const base: GitWorkflow = {
    state: "loading",
    branch: copy.branch || undefined,
    prNumber: pr?.number,
    prUrl: pr?.url,
    ahead: git?.ahead,
    behind: git?.behind,
    changedFiles: copy.changedFiles || undefined,
    // Two things the app cannot do for a PR: fix CI on its own, or pull the
    // review threads into a chat. Saying so swaps those buttons for the ones
    // it can do (open the checks) or for no button at all.
    hasFixableChecks: false,
    hasPendingComments: false,
    canAutoMerge: false,
  };
  const at = (state: GitWorkflowState, extra?: Partial<GitWorkflow>): GitWorkflow => ({
    ...base,
    state,
    ...extra,
  });
  if (copy.agents.some((a) => !a.attention) || cloudRunning(copy)) return at("working");
  if (pr?.state === "merged") return at("merged");
  if (pr?.state === "closed") return at("closed");
  if (hasDiff(copy)) return at("uncommitted");
  if (git?.hasUpstream && git.behind > 0) {
    return at(git.ahead > 0 ? "diverged" : "behind");
  }
  if (pr && git?.hasUpstream && git.ahead > 0) return at("ahead");
  if (pr) {
    if (pr.draft) return at("draft");
    if (pr.checksState === "failure") {
      return at("checks-failing", {
        failedChecks: pr.checksFailing,
        totalChecks: pr.checksTotal,
      });
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") return at("changes-requested");
    if (pr.checksState === "pending") {
      return at("checks-pending", { pendingChecks: pr.checksPending });
    }
    if (pr.reviewDecision === "APPROVED") return at("ready");
    return at("review-required");
  }
  // The main checkout is what a PR merges INTO, so it never offers one.
  if (!copy.isMain && git && git.ahead > 0) return at("no-pr");
  if (git?.hasUpstream === false && git.ahead > 0) return at("ahead");
  // Nothing to do, or git not read yet. `loading` is the state that draws no
  // control on a row, which is right for both: no button is a true answer.
  return at("loading");
}

/** One plain line under the title: who is on it, else what the PR is called. */
export function copySummary(copy: WorkspaceCopy, pr: CopyPr | null): string | undefined {
  const waiting = copy.agents.find((a) => a.attention);
  if (waiting) return `${waiting.label} needs you`;
  if (copy.agents.length) {
    const more = copy.agents.length - 1;
    return `${copy.agents[0]!.label} is working${more > 0 ? ` with ${more} more` : ""}`;
  }
  if (cloudRunning(copy)) return "Running on another machine";
  if (copy.cloud) return "Waiting for a machine";
  return pr?.title || undefined;
}

export type CopyOverviewInput = {
  copy: WorkspaceCopy;
  nowMs: number;
  pr: PrSummary | null | undefined;
  git: FleetGit | null | undefined;
  archived: boolean;
};

export function copyOverview(input: CopyOverviewInput): WorkspaceOverview {
  const { copy, nowMs, git, archived } = input;
  const pr = copyPr(copy, input.pr);
  const diff = copy.added > 0 || copy.removed > 0;
  return {
    id: copy.path,
    title: copy.title,
    branch: copy.branch || "Detached HEAD",
    project: copy.projectName,
    projectId: copy.root,
    stage: copyStage(pr),
    summary: copySummary(copy, pr),
    updatedAt: (copy.committedAt ?? 0) * 1000,
    createdAt: copy.createdAt != null ? copy.createdAt * 1000 : undefined,
    timeLabel: relTime(copy.committedAt, nowMs),
    added: diff ? copy.added : undefined,
    removed: diff ? copy.removed : undefined,
    archived,
    unread: copy.agents.some((a) => a.attention),
    workflow: copyWorkflow(copy, pr, git),
  };
}

function stamp(iso: string | null): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

function repoName(job: CloudJobWithRoot): string {
  const named = projectLabel(job.repo);
  if (named) return named;
  const tail = job.repoRoot.split("/").filter(Boolean).pop();
  return tail || "Cloud";
}

/** Work sent to a machine that isn't this one, as a row beside the copies.
 *  Its stage and its one control come from the job's own status: running is
 *  in progress with the working mark, finished is done, a failure or refusal
 *  went nowhere, and work no machine has picked up yet is backlog. */
export function cloudThreadOverview(
  thread: CloudThread,
  nowMs: number,
  archived: boolean,
): WorkspaceOverview {
  const job = thread.latest;
  const running = isCloudJobRunning(job.status) && !isCloudJobStranded(job, nowMs);
  const claimed = running && job.status !== "submitted";
  const at = stamp(job.created_at);
  const first = stamp(thread.jobs[0]?.created_at ?? null);
  const status = cloudStatusLine(job, nowMs).label;
  const stage: WorkspaceStage =
    job.status === "completed"
      ? "done"
      : ["failed", "canceled", "rejected"].includes(job.status)
        ? "canceled"
        : claimed || job.status === "input-required"
          ? "in-progress"
          : "backlog";
  return {
    id: `${CLOUD_ROW_PREFIX}${thread.key}`,
    title: thread.title.split("\n")[0]!.trim() || "Cloud work",
    branch: job.branch || "Cloud",
    project: repoName(job),
    projectId: job.repoRoot || job.repo || "cloud",
    stage,
    summary: job.error_message ? `${status}: ${job.error_message}` : status,
    updatedAt: at,
    createdAt: first || undefined,
    timeLabel: at ? relTime(Math.floor(at / 1000), nowMs) : "",
    archived,
    unread: job.status === "input-required",
    workflow: { state: claimed ? "working" : "loading", branch: job.branch ?? undefined },
  };
}

/** A cloud conversation on a branch this disk already has a copy of is the
 *  same work twice; the copy row already carries the cloud placement. */
export function cloudThreadsOffDisk(
  threads: CloudThread[],
  copies: WorkspaceCopy[],
): CloudThread[] {
  const local = new Set(copies.map((c) => `${c.root}\u0000${c.branch}`));
  return threads.filter((t) => {
    const branch = t.latest.branch;
    return !branch || !local.has(`${t.latest.repoRoot}\u0000${branch}`);
  });
}
