// "Pull" on the "N commits behind <target>" row: bring the target branch into
// this one. A fast-forward runs here straight away; anything that needs a
// merge — work on this branch the target lacks, or uncommitted files in the
// way — opens a chat that does the merge, as the other Resolve rows do.

import type { TargetSync } from "../../lib/branchSync";
import type { GitChatRequest } from "../../lib/gitChatPrompts";

export type PullLatestChat = Extract<GitChatRequest, { action: "pull-latest" }>;

export type PullLatestDeps = {
  fetch: () => Promise<unknown>;
  sync: () => Promise<TargetSync | null>;
  fastForward: (targetRef: string) => Promise<void>;
  startChat: (req: PullLatestChat) => void;
  /** Uncommitted files now. */
  changedCount: () => Promise<number>;
};

export type PullLatestOutcome = "up-to-date" | "fast-forwarded" | "handed-to-chat";

export const PULL_LATEST_JOB = "pull-latest";

/** Runs the pull. Throws with what went wrong; the caller toasts it. */
export async function pullLatestFromTarget(
  target: TargetSync,
  deps: PullLatestDeps,
): Promise<PullLatestOutcome> {
  const reconcile = (hasUncommitted: boolean, at: TargetSync) => {
    deps.startChat({
      action: "pull-latest",
      remote: at.remote,
      target: at.target,
      hasUncommittedChanges: hasUncommitted,
    });
    return "handed-to-chat" as const;
  };
  if ((await deps.changedCount()) > 0) return reconcile(true, target);
  try {
    await deps.fetch();
  } catch (e) {
    throw new Error(`Failed to fetch from remote: ${e instanceof Error ? e.message : String(e)}`);
  }
  if ((await deps.changedCount()) > 0) return reconcile(true, target);
  const now = await deps.sync();
  if (!now) throw new Error(`Target branch ${target.target} does not exist`);
  if (now.ahead === 0 && now.behind === 0) return "up-to-date";
  if (now.behind > 0 && now.ahead === 0) {
    await deps.fastForward(now.target_ref);
    return "fast-forwarded";
  }
  return reconcile(false, now);
}
