// The facts a pull request's page draws: the one next step it offers, and
// everything that happened to it since it opened, newest first.

import type { GraphCommit, PrComment, PrDetail, PrReviewer } from "../../../lib/api";
import type { GitWorkflow } from "../../ui/git-workflow";

/** The check counts GitHub reports for a pull request. */
export type PrChecksTally = {
  state: string | null;
  passing: number;
  failing: number;
  pending: number;
  total: number;
};

/** Where the pull request stands, as the workflow the page's action reads.
 *  The order is the order a reader would fix things in: a finished PR is
 *  only archived, a draft is made ready first, a conflict or a red check
 *  blocks before a review does, and pending checks only hold up a merge that
 *  would otherwise be ready. Approve is offered to someone other than the
 *  author; until we know who is looking, nobody is offered it. */
export function prWorkflow(
  detail: PrDetail,
  checks: PrChecksTally | null,
  viewer: string,
  comments: PrComment[],
): GitWorkflow {
  const base: GitWorkflow = {
    state: "ready",
    prNumber: detail.number,
    prUrl: detail.url,
    branch: detail.head_ref,
    targetBranch: detail.base_ref,
    failedChecks: checks?.failing,
    totalChecks: checks?.total,
    pendingChecks: checks?.pending,
  };
  if (detail.state === "MERGED") return { ...base, state: "merged" };
  if (detail.state === "CLOSED") return { ...base, state: "closed" };
  if (detail.is_draft) return { ...base, state: "draft" };
  if (detail.mergeable === "CONFLICTING") return { ...base, state: "unable-to-merge" };
  if (checks && checks.failing > 0) {
    // Nothing here can fix a check on its own, so the step is to read them.
    return { ...base, state: "checks-failing", hasFixableChecks: false, logsAvailable: false };
  }
  if (detail.review_decision === "CHANGES_REQUESTED") {
    return { ...base, state: "changes-requested", hasPendingComments: saidComments(comments).length > 0 };
  }
  if (detail.review_decision === "REVIEW_REQUIRED") {
    const canApprove = viewer !== "" && viewer !== detail.author;
    return { ...base, state: canApprove ? "approve-pr" : "review-required" };
  }
  if (checks && checks.pending > 0) return { ...base, state: "checks-pending", canAutoMerge: false };
  return base;
}

/** Comments with something in them — what "send the comments" sends. */
export function saidComments(comments: PrComment[]): PrComment[] {
  return comments.filter((c) => c.body.trim().length > 0);
}

/** A reviewer as the details row names them: the login, and their verdict
 *  once they have given one. */
export function reviewerLabel(r: PrReviewer): string {
  const verdict =
    r.state === "APPROVED"
      ? "approved"
      : r.state === "CHANGES_REQUESTED"
        ? "changes requested"
        : r.state === "COMMENTED"
          ? "commented"
          : null;
  return verdict ? `${r.login} (${verdict})` : r.login;
}

/** Review threads on lines of the diff — the root comment of each. */
export function reviewThreads(comments: PrComment[]): { total: number; unresolved: number } {
  const roots = comments.filter((c) => !c.is_issue_comment && c.in_reply_to == null && c.line != null);
  return { total: roots.length, unresolved: roots.filter((r) => !r.thread_resolved).length };
}

export type PrActivityEntry = {
  id: string;
  author: string;
  message: string;
  /** Epoch milliseconds. */
  at: number;
  kind: "commit" | "comment" | "event";
  sha?: string;
  /** A comment's words, as written (markdown). */
  body?: string;
};

/** The pull request's history: opened, each commit on the branch, each
 *  comment, and how it ended — newest first, the order the page lists it. */
export function prActivity(
  detail: PrDetail,
  comments: PrComment[],
  commits: GraphCommit[],
): PrActivityEntry[] {
  const out: PrActivityEntry[] = [
    {
      id: "opened",
      author: detail.author,
      message: "opened this pull request",
      at: Date.parse(detail.created_at),
      kind: "event",
    },
  ];
  for (const c of commits) {
    out.push({
      id: `commit:${c.sha}`,
      author: c.author,
      message: c.subject,
      sha: c.short,
      at: c.timestamp * 1000,
      kind: "commit",
    });
  }
  for (const c of saidComments(comments)) {
    const where = c.path ? `${c.path}${c.line != null ? `:${c.line}` : ""}` : null;
    out.push({
      id: `comment:${c.id}`,
      author: c.author,
      message: where ? `${c.in_reply_to != null ? "replied on" : "commented on"} ${where}` : "commented",
      at: Date.parse(c.created_at),
      kind: "comment",
      body: c.body,
    });
  }
  if (detail.merged_at) {
    out.push({
      id: "merged",
      author: detail.merged_by ?? "",
      message: `merged into ${detail.base_ref}`,
      at: Date.parse(detail.merged_at),
      kind: "event",
    });
  } else if (detail.state === "CLOSED") {
    out.push({
      id: "closed",
      author: "",
      message: "Closed without merging",
      at: Date.parse(detail.updated_at),
      kind: "event",
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A stack from its base up: each root, then what was stacked on it. */
export function stackOrder<T extends { number: number; parent: number | null; children: number[] }>(
  nodes: T[],
): T[] {
  const byNum = new Map(nodes.map((n) => [n.number, n] as const));
  const out: T[] = [];
  const seen = new Set<number>();
  const walk = (n: T, depth: number) => {
    // A real stack has no cycle; the depth cap keeps a bad answer finite.
    if (depth > 64 || seen.has(n.number)) return;
    seen.add(n.number);
    out.push(n);
    for (const c of n.children) {
      const child = byNum.get(c);
      if (child) walk(child, depth + 1);
    }
  };
  for (const n of nodes) if (n.parent == null || !byNum.has(n.parent)) walk(n, 0);
  for (const n of nodes) if (!seen.has(n.number)) out.push(n);
  return out;
}

/** The mark tone for a 0–100 risk score. */
export function riskMarkTone(score: number): "danger" | "warn" | "good" {
  return score >= 70 ? "danger" : score >= 40 ? "warn" : "good";
}
