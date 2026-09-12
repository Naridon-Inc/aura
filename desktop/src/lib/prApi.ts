// The PR actions, wherever the checkout stands.
//
// Every `api.pr*` call takes a trailing `remoteRepo` (AURA-1307): the
// `owner/repo` that `gh -R` is told when the checkout is on a machine, or
// `null` when it is here and `gh` can read the repo off the checkout itself.
// This module is where that argument is filled in, once, so a button that
// approves, merges, labels or comments swaps one import and nothing else —
// and none of them can forget to ask, or ask differently.
//
// The three PR *reads* with a cache (`prList`, `prDetail`, `prCommentsList`)
// are not here: their caches ask `remoteRepoFor` themselves, keyed by place.
// `prCreate` is special and lives at the end.

import { api, type PrCreated, type ReactionContent } from "./api";
import { gitBranch, gitPush } from "./place/workApi";
import { machineIdForRoot } from "./activeMachine";
import { remoteRepoFor } from "./prRepo";

export async function prWhoami(repoRoot: string): Promise<string> {
  return api.prWhoami(repoRoot, await remoteRepoFor(repoRoot));
}

export async function prLabelsList(repoRoot: string) {
  return api.prLabelsList(repoRoot, await remoteRepoFor(repoRoot));
}

export async function prLabelsSet(
  repoRoot: string,
  prNumber: number,
  names: string[],
): Promise<void> {
  return api.prLabelsSet(repoRoot, prNumber, names, await remoteRepoFor(repoRoot));
}

export async function prUpdate(
  repoRoot: string,
  prNumber: number,
  title: string | null,
  body: string | null,
): Promise<void> {
  return api.prUpdate(repoRoot, prNumber, title, body, await remoteRepoFor(repoRoot));
}

export async function prChecks(repoRoot: string, prNumber: number) {
  return api.prChecks(repoRoot, prNumber, await remoteRepoFor(repoRoot));
}

export async function prVercelStatus(repoRoot: string, prNumber: number) {
  return api.prVercelStatus(repoRoot, prNumber, await remoteRepoFor(repoRoot));
}

export async function prCommentPost(
  repoRoot: string,
  prNumber: number,
  file: string,
  line: number,
  body: string,
  side?: "RIGHT" | "LEFT",
  startLine?: number,
) {
  return api.prCommentPost(
    repoRoot,
    prNumber,
    file,
    line,
    body,
    side,
    startLine,
    await remoteRepoFor(repoRoot),
  );
}

export async function prCommentPostIssue(
  repoRoot: string,
  prNumber: number,
  body: string,
) {
  return api.prCommentPostIssue(repoRoot, prNumber, body, await remoteRepoFor(repoRoot));
}

export async function prCommentReply(
  repoRoot: string,
  prNumber: number,
  inReplyTo: number,
  body: string,
) {
  return api.prCommentReply(
    repoRoot,
    prNumber,
    inReplyTo,
    body,
    await remoteRepoFor(repoRoot),
  );
}

export async function prCommentResolve(
  repoRoot: string,
  threadNodeId: string,
): Promise<void> {
  return api.prCommentResolve(repoRoot, threadNodeId, await remoteRepoFor(repoRoot));
}

export async function prReactionAdd(
  repoRoot: string,
  commentNodeId: string,
  content: ReactionContent,
): Promise<void> {
  return api.prReactionAdd(repoRoot, commentNodeId, content, await remoteRepoFor(repoRoot));
}

export async function prReactionRemove(
  repoRoot: string,
  commentNodeId: string,
  content: ReactionContent,
): Promise<void> {
  return api.prReactionRemove(
    repoRoot,
    commentNodeId,
    content,
    await remoteRepoFor(repoRoot),
  );
}

export async function prApprove(
  repoRoot: string,
  prNumber: number,
  body?: string,
): Promise<void> {
  return api.prApprove(repoRoot, prNumber, body, await remoteRepoFor(repoRoot));
}

export async function prRequestChanges(
  repoRoot: string,
  prNumber: number,
  body: string,
): Promise<void> {
  return api.prRequestChanges(repoRoot, prNumber, body, await remoteRepoFor(repoRoot));
}

export async function prCommentReview(
  repoRoot: string,
  prNumber: number,
  body: string,
): Promise<void> {
  return api.prCommentReview(repoRoot, prNumber, body, await remoteRepoFor(repoRoot));
}

export async function prMerge(
  repoRoot: string,
  prNumber: number,
  strategy: "squash" | "merge" | "rebase",
  deleteBranch: boolean,
): Promise<void> {
  return api.prMerge(repoRoot, prNumber, strategy, deleteBranch, await remoteRepoFor(repoRoot));
}

export async function prStack(repoRoot: string, prNumber: number) {
  return api.prStack(repoRoot, prNumber, await remoteRepoFor(repoRoot));
}

export async function githubIssueList(repoRoot: string) {
  return api.githubIssueList(repoRoot, await remoteRepoFor(repoRoot));
}

export async function prEdit(input: {
  repoRoot: string;
  prNumber: number;
  title: string;
  body: string;
  baseBranch?: string | null;
  draft: boolean;
}): Promise<void> {
  return api.prEdit({ ...input, remoteRepo: await remoteRepoFor(input.repoRoot) });
}

/** Open a pull request from the branch the workspace is on.
 *
 *  On this laptop the backend does it all: reads the branch, pushes it, asks
 *  `gh`. On a machine the branch is over there, so the two halves `gh` cannot
 *  do without a checkout are done here first — the branch is pushed FROM the
 *  box (`git push -u`, through the same door every other git act uses), and
 *  its name is read off the box when the caller did not say — and `gh` is
 *  then told the head outright. */
export async function prCreate(input: {
  repoRoot: string;
  headBranch?: string | null;
  title: string;
  body: string;
  baseBranch?: string | null;
  draft: boolean;
}): Promise<PrCreated> {
  const { repoRoot } = input;
  if (!machineIdForRoot(repoRoot)) return api.prCreate(input);
  const remoteRepo = await remoteRepoFor(repoRoot);
  const headBranch = input.headBranch?.trim() || (await gitBranch(repoRoot)).trim();
  if (!headBranch) {
    throw new Error("The checkout on the machine isn't on a branch, so there is nothing to open a pull request from.");
  }
  await gitPush(repoRoot, true);
  return api.prCreate({ ...input, headBranch, remoteRepo });
}
