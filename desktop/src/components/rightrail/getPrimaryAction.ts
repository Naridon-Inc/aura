// Pure decider for what the CommitInput's main button should do RIGHT
// NOW. Mirrors Superset's getPrimaryAction but trimmed to the verbs we
// have backends for (no PR-aware push variant in v1).
//
// Priority (highest first):
//   1. canCommit       → "Commit"     (staged + non-empty message)
//   2. push && pull    → "Sync"       (both directions diverged)
//   3. push only       → "Push"
//   4. pull only       → "Pull"
//   5. no upstream     → "Publish branch"
//   6. fallthrough     → disabled "Commit" with hint
// Kept as a pure fn so primary-action behaviour is testable + traceable.

export type PrimaryActionType = "commit" | "sync" | "push" | "pull" | "publish";

export type PrimaryActionState = {
  action: PrimaryActionType;
  label: string;
  disabled: boolean;
  tooltip: string;
};

export type PrimaryActionInput = {
  canCommit: boolean;
  hasStagedChanges: boolean;
  isPending: boolean;
  pushCount: number;
  pullCount: number;
  hasUpstream: boolean;
};

export function getPrimaryAction({
  canCommit,
  hasStagedChanges,
  isPending,
  pushCount,
  pullCount,
  hasUpstream,
}: PrimaryActionInput): PrimaryActionState {
  if (canCommit) {
    return {
      action: "commit",
      label: "Commit",
      disabled: isPending,
      tooltip: "Commit staged changes",
    };
  }
  if (pushCount > 0 && pullCount > 0) {
    return {
      action: "sync",
      label: "Sync",
      disabled: isPending,
      tooltip: `Pull ${pullCount}, push ${pushCount}`,
    };
  }
  if (pushCount > 0) {
    return {
      action: "push",
      label: "Push",
      disabled: isPending,
      tooltip: `Push ${pushCount} commit${pushCount === 1 ? "" : "s"}`,
    };
  }
  if (pullCount > 0) {
    return {
      action: "pull",
      label: "Pull",
      disabled: isPending,
      tooltip: `Pull ${pullCount} commit${pullCount === 1 ? "" : "s"}`,
    };
  }
  if (!hasUpstream) {
    return {
      action: "publish",
      label: "Publish branch",
      disabled: isPending,
      tooltip: "Publish this branch to origin",
    };
  }
  return {
    action: "commit",
    label: "Commit",
    disabled: true,
    tooltip: hasStagedChanges ? "Enter a message" : "Nothing to commit",
  };
}
