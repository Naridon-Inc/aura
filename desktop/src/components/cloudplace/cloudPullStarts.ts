// A project's open pull requests, as starting points for a cloud workspace.
//
// A workspace started from one works on the pull request's own branch: the
// computer checks GitHub's copy of it out, and what the agent pushes lands on
// the same pull request. A pull request opened from someone else's copy of
// the project (a fork) has its branch over there, where the org can't push,
// so it is listed with the reason it can't start here rather than left out.
// The laptop can start one: it fetches the pull request into a branch of its
// own.

import { cloudApi, cloudProblem, type CloudOpenPull } from "../../lib/cloudWorkspacesApi";
import type { CloudPullRequestStart } from "../ui/cloud-workspace-create";

export function forkReason(pr: Pick<CloudOpenPull, "number" | "head_repo">): string {
  const owner = pr.head_repo?.split("/")[0]?.trim();
  const whose = owner ? `${owner}’s copy of the project` : "a copy of the project that was deleted";
  return `#${pr.number} comes from ${whose}, so a cloud workspace can’t push to its branch. Start it from your laptop instead.`;
}

export function pullStarts(rows: readonly CloudOpenPull[]): CloudPullRequestStart[] {
  return rows.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.head,
    draft: pr.draft,
    unavailable: pr.from_fork ? forkReason(pr) : null,
  }));
}

/** Why the list couldn't be read: the cloud's own sentence when it gave one. */
export function pullListProblem(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const body = /^HTTP \d{3}[^:]*: ([\s\S]*)$/.exec(raw.trim())?.[1];
  if (body) {
    try {
      const said = JSON.parse(body)?.message;
      if (typeof said === "string" && said.trim()) return said.trim();
    } catch {
      /* not the cloud's JSON; say it the general way */
    }
  }
  const problem = cloudProblem(e);
  return problem.kind === "unavailable" ? "This cloud can’t list pull requests yet." : problem.message;
}

export async function readPullStarts(
  repo: string,
  list: (repo: string) => Promise<{ pulls?: CloudOpenPull[] | null }> = cloudApi.openPulls,
): Promise<CloudPullRequestStart[]> {
  try {
    const answer = await list(repo);
    return pullStarts(answer?.pulls ?? []);
  } catch (e) {
    throw new Error(pullListProblem(e));
  }
}

/** What the workspace row records about where it started. */
export function pullStartIntent(pr: Pick<CloudPullRequestStart, "number" | "branch">): string {
  return `Starts from pull request #${pr.number} on ${pr.branch}`;
}
