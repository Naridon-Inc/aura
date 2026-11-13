// The mark a workspace row wears for its branch's pull request, and the words
// beside its number. One workspace is one branch and at most one pull
// request, so the row can say where that PR stands without opening it.

import type { WorktreeBadgePr } from "../../../lib/useWorktreeBadges";
import type { WorkspaceStatus } from "../../ui/workspace-status";

/** Finished states first, then what needs a hand before a review can start:
 *  a red check outranks a draft, a draft outranks checks still running. Null
 *  when there is no pull request, or one in a state we don't know. */
export function prWorkspaceStatus(pr: WorktreeBadgePr | undefined): WorkspaceStatus | null {
  if (!pr) return null;
  const state = pr.state.toLowerCase();
  if (state === "merged") return "merged";
  if (state === "closed") return "closed-pr";
  if (state !== "open") return null;
  if (pr.checks === "failure") return "checks-failing";
  if (pr.draft) return "draft-pr";
  if (pr.checks === "pending") return "checks-pending";
  return "open-pr";
}

/** "#101 · Checks failing", the hover on the number in the row's trailing
 *  slot. */
export function prNumberTitle(pr: WorktreeBadgePr): string {
  const words: Record<string, string> = {
    merged: "Merged",
    "closed-pr": "Closed without merging",
    "checks-failing": "Checks failing",
    "draft-pr": "Draft",
    "checks-pending": "Checks running",
    "open-pr": "Open",
  };
  const status = prWorkspaceStatus(pr);
  return status ? `#${pr.number} · ${words[status]}` : `#${pr.number}`;
}
