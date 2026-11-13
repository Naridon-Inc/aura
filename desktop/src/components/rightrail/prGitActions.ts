// The pull request moves both git status surfaces make straight away — the
// header's button and the Checks tab's rows — so they do the same thing.

import type { PrMergeState } from "../../lib/branchSync";
import { prApprove, prEdit, prMerge } from "../../lib/prApi";
import { fetchPrDetail } from "../../lib/prDetailCache";
import { invalidatePrList } from "../../lib/prsCache";

/** Take the pull request out of draft. GitHub's edit needs the title and
 *  description along with it, so they are read first and sent unchanged. */
export async function markReadyForReview(repoRoot: string, prNumber: number): Promise<void> {
  const detail = await fetchPrDetail(repoRoot, prNumber);
  await prEdit({ repoRoot, prNumber, title: detail.title, body: detail.body, draft: false });
  await invalidatePrList(repoRoot).catch(() => {});
}

/** Approve the pull request as you, then read the list again so the review
 *  decision moves on. */
export async function approvePullRequest(repoRoot: string, prNumber: number): Promise<void> {
  await prApprove(repoRoot, prNumber);
  await invalidatePrList(repoRoot).catch(() => {});
}

/** Merge the pull request the way its repository merges (`merge_method`,
 *  squash when that couldn't be read), keeping its branch. */
export async function mergePullRequest(
  repoRoot: string,
  prNumber: number,
  method: PrMergeState["merge_method"] = null,
): Promise<void> {
  await prMerge(repoRoot, prNumber, method ?? "squash", false);
  await invalidatePrList(repoRoot).catch(() => {});
}
