// Pure deriver for the review-rail state header (Conductor's colored PR /
// branch lifecycle bar). Given the real git + PR facts, it decides ONE
// dominant state — a tint colour, a plain-language label, and the primary
// (and, for a merged PR, secondary) action the bar offers.
//
// Kept pure — no React, no api — so the lifecycle precedence is testable and
// traceable in isolation, the same way `getPrimaryAction` is for the commit
// button. The view (`ReviewStateHeader`) only renders what this returns and
// wires the buttons to the reused git/PR handlers.
//
// Precedence (highest first), matching the spec:
//   conflicts > merged > ready-to-merge > behind > ahead > unpublished >
//   uncommitted > clean.

export type ReviewStateId =
  | "conflicts"
  | "merged"
  | "ready"
  | "behind"
  | "ahead"
  | "unpublished"
  | "uncommitted"
  | "clean";

/** Maps to a CSS status token in the view. `neutral` = a faint elevated wash
 *  (no status colour), `none` = no tint at all (the calm in-sync state). */
export type ReviewTone = "red" | "violet" | "green" | "amber" | "neutral" | "none";

export type ReviewActionId =
  | "resolve"
  | "continue"
  | "archive"
  | "merge"
  | "pull"
  | "push"
  | "publish"
  | "commit_push";

export type ReviewAction = {
  id: ReviewActionId;
  label: string;
};

export type ReviewState = {
  id: ReviewStateId;
  /** Plain-language label for the bar (non-engineer audience). */
  label: string;
  tone: ReviewTone;
  /** Primary action, or null for the calm clean state. */
  primary: ReviewAction | null;
  /** Only the merged state carries a second action (Archive). */
  secondary: ReviewAction | null;
};

export type ReviewPrFacts = {
  number: number;
  /** Raw gh state — normalised here, so "OPEN" / "open" both work. */
  state: string;
  reviewDecision: string | null;
};

export type ReviewStateInput = {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  /** Uncommitted (working-tree, vs HEAD) changed-file count. */
  changedCount: number;
  conflictsCount: number;
  pr: ReviewPrFacts | null;
  /** True only when a REAL merge capability is wired (so we never fake a
   *  Merge button). The view passes `true` because `api.prMerge` exists. */
  canMerge: boolean;
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function deriveReviewState(i: ReviewStateInput): ReviewState {
  const prState = (i.pr?.state ?? "").toLowerCase();
  const prOpen = i.pr != null && prState === "open";
  const prMerged = i.pr != null && prState === "merged";

  // 1. Merge conflicts dominate everything — the tree can't move until they
  //    are resolved.
  if (i.conflictsCount > 0) {
    return {
      id: "conflicts",
      label: "Merge conflicts",
      tone: "red",
      primary: { id: "resolve", label: "Resolve" },
      secondary: null,
    };
  }

  // 2. Merged PR — the work landed. Continue to the next step, or archive the
  //    finished copy.
  if (prMerged) {
    return {
      id: "merged",
      label: "Merged",
      tone: "violet",
      primary: { id: "continue", label: "Continue" },
      secondary: { id: "archive", label: "Archive" },
    };
  }

  // 3. Open PR, branch pushed & clean → ready to merge. Only offer a real
  //    Merge when the capability exists; otherwise fall back to opening it.
  if (prOpen && i.hasUpstream && i.ahead === 0 && i.changedCount === 0) {
    return i.canMerge
      ? {
          id: "ready",
          label: "Ready to merge",
          tone: "green",
          primary: { id: "merge", label: "Merge" },
          secondary: null,
        }
      : {
          id: "ready",
          label: `Open · #${i.pr!.number}`,
          tone: "green",
          // No merge backend — open the PR instead of faking a Merge.
          primary: { id: "continue", label: `Open #${i.pr!.number}` },
          secondary: null,
        };
  }

  // 4. Behind the remote → pull.
  if (i.hasUpstream && i.behind > 0) {
    return {
      id: "behind",
      label: `Behind by ${i.behind} ${plural(i.behind, "commit", "commits")}`,
      tone: "amber",
      primary: { id: "pull", label: "Pull" },
      secondary: null,
    };
  }

  // 5. Ahead only → push.
  if (i.hasUpstream && i.ahead > 0) {
    return {
      id: "ahead",
      label: `${i.ahead} ${plural(i.ahead, "commit", "commits")} ahead`,
      tone: "neutral",
      primary: { id: "push", label: "Push" },
      secondary: null,
    };
  }

  // 6. No upstream → publish.
  if (!i.hasUpstream) {
    return {
      id: "unpublished",
      label: "Unpublished branch",
      tone: "neutral",
      primary: { id: "publish", label: "Publish" },
      secondary: null,
    };
  }

  // 7. Uncommitted working-tree changes with nothing else pending.
  if (i.changedCount > 0) {
    return {
      id: "uncommitted",
      label: "Uncommitted changes",
      tone: "amber",
      primary: { id: "commit_push", label: "Commit and push" },
      secondary: null,
    };
  }

  // 8. Clean + in sync — a calm resting state, no tint, no action.
  return {
    id: "clean",
    label: "Up to date",
    tone: "none",
    primary: null,
    secondary: null,
  };
}

/** CSS custom-property name for a tone's status colour, or null for the
 *  neutral / none tones (which the view renders with plain text tokens). */
export function toneVar(tone: ReviewTone): string | null {
  switch (tone) {
    case "red":
      return "--color-red";
    case "violet":
      return "--color-violet";
    case "green":
      return "--color-accent-green";
    case "amber":
      return "--color-amber";
    default:
      return null;
  }
}
