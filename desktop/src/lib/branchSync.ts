// The branch against the branch its work goes into, and the pull request's
// mergeability as GitHub computes it: the facts behind the Checks tab's
// "N commits behind main", merge conflict and merge queue rows.
//
// The git reads run on this laptop's checkouts only. A workspace on a machine
// answers `null` — its place commands don't count against a target yet — so
// the rows they feed stay off there rather than guessing.

import { invoke } from "@tauri-apps/api/core";

import { remotePlaceForRoot } from "./activeMachine";
import { remoteRepoFor } from "./prRepo";

/** The branch's distance from its target, on the remote-tracking ref. */
export type TargetSync = {
  remote: string;
  /** Short name, e.g. `main`. */
  target: string;
  /** e.g. `refs/remotes/origin/main` — what a fast-forward moves to. */
  target_ref: string;
  ahead: number;
  behind: number;
};

export type MergeQueueState = "AWAITING_CHECKS" | "LOCKED" | "MERGEABLE" | "QUEUED" | "UNMERGEABLE";

export type PrMergeState = {
  /** GitHub's MergeStateStatus: CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, … */
  merge_state_status: string | null;
  mergeable: string | null;
  base_ref: string;
  /** Set while the pull request is in a merge queue. */
  merge_queue_state: MergeQueueState | null;
  /** How Merge merges: the first the repository allows of squash, rebase and
   *  a merge commit. Absent or null when it couldn't be read. */
  merge_method?: "squash" | "rebase" | "merge" | null;
  /** You can approve it: write access or more, not its author, and not yet
   *  reviewed by you at its latest commit. */
  can_approve?: boolean;
};

/** The header and the Checks tab read on the same tick: one read answers
 *  both, and a repeat within a few seconds reuses it. */
const FRESH_MS = 4000;
const recent = new Map<string, { at: number; read: Promise<unknown> }>();
function shared<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.read as Promise<T>;
  const p = read();
  recent.set(key, { at: Date.now(), read: p });
  p.catch(() => recent.delete(key));
  return p;
}

/** How far the branch is from `target` (the pull request's base), or from the
 *  remote's default branch when there is none. `null` with no remote, no
 *  target, or on a machine. */
export function gitTargetSync(repoRoot: string, target: string | null): Promise<TargetSync | null> {
  if (remotePlaceForRoot(repoRoot)) return Promise.resolve(null);
  return shared(`sync:${repoRoot}:${target ?? ""}`, () =>
    invoke<TargetSync | null>("git_target_sync", { repoRoot, target: target || null }),
  );
}

/** `git merge --ff-only <targetRef>`. Rejects with git's refusal. */
export function gitFastForward(repoRoot: string, targetRef: string): Promise<void> {
  if (remotePlaceForRoot(repoRoot)) {
    return Promise.reject(new Error("Pulling from the target branch isn't available on a machine yet."));
  }
  recent.clear();
  return invoke<void>("git_fast_forward", { repoRoot, targetRef });
}

/** The merge state of pull request `number`, wherever the checkout lives. */
export function prMergeState(repoRoot: string, number: number): Promise<PrMergeState> {
  return shared(`merge:${repoRoot}:${number}`, async () => {
    const remoteRepo = await remoteRepoFor(repoRoot);
    return invoke<PrMergeState>("pr_merge_state", { repoRoot, number, remoteRepo: remoteRepo ?? null });
  });
}

/** Forget the reads, after something here moved the branch. */
export function forgetBranchSync(): void {
  recent.clear();
}
