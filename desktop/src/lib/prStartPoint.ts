// Where a new copy should start when someone picks a pull request.
//
// A PR from a branch in this repo starts from that branch name — git already
// has it (or `origin/<branch>`). A PR from a FORK has no branch here at all:
// its head lives in someone else's repo, so the only thing to start from is
// GitHub's synthetic `pull/<n>/head` ref, fetched into a local branch first.
// The backend (`worktree::resolve_start_point`) understands the
// `pull/<n>/head:<local>` spelling and does the fetch; this module decides
// the spelling and the local branch name. PURE, so it is unit tested.

import type { PrSummary } from "./api";

/** The facts the decision needs — a `PrSummary` has them, and a test can
 *  hand in just these. */
export type PrStartPointInput = Pick<
  PrSummary,
  "number" | "head_ref" | "is_cross_repository"
>;

/** Squash a branch name into something safe for a local branch: keep
 *  letters, digits, `.`, `_`, `-` and `/`; everything else becomes `-`;
 *  no leading/trailing separators, no `..`. */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._\-/]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "");
  return cleaned;
}

/** Local branch a fork PR's head is fetched into: `pr-<n>-<headref>`. */
export function forkPrLocalBranch(pr: PrStartPointInput): string {
  const tail = sanitizeBranchName(pr.head_ref);
  return tail ? `pr-${pr.number}-${tail}` : `pr-${pr.number}`;
}

/** The git start point to hand the worktree creator for this PR. */
export function prStartPoint(pr: PrStartPointInput): string {
  if (!pr.is_cross_repository) return pr.head_ref;
  return `pull/${pr.number}/head:${forkPrLocalBranch(pr)}`;
}
