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
//   unknown > conflicts > merged > ready-to-merge > behind > ahead >
//   unpublished > uncommitted > clean.
//
// `unknown` leads because it isn't a state of the branch — it's the absence
// of a reading, and nothing below it can be decided without one. Every
// surface that draws these used to start life at `{ahead: 0, behind: 0,
// has_upstream: false}` and fall straight through to "unpublished", so the
// first frame of the review rail told you nobody could see your work and
// offered to publish it, before a single git command had returned. When the
// read then FAILED, that fabricated initial was what the `catch` kept.

import { countOf, plural } from "../../lib/plural";

export type ReviewStateId =
  | "unknown"
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
  /** Plain-language label for the bar (non-engineer audience). What this
   *  promised and what it returned had drifted apart — see
   *  `branchStateLabel`. */
  label: string;
  /** The same state said precisely, for the hover. `branchStateDetail`. */
  detail: string;
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
  /** False until a git read has actually come back — and false again if the
   *  latest one failed with nothing earlier to fall back on. Every field
   *  below is meaningless while this is false, which is precisely why it
   *  can't be inferred from them: `{0, 0, false}` is a valid answer AND the
   *  shape of never having asked. */
  known: boolean;
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

/** The ONE name each branch state goes by, app-wide.
 *
 *  Two surfaces render these same git conditions and each used to write its own
 *  copy: this header bar shows the single dominant state, and the Checks strip
 *  lists every state that's true at once. So on a conflicted branch the bar read
 *  "Merge conflicts" fifteen rows above a row reading "Incompatible with
 *  remote" — one condition, one Resolve button behind each, two names on one
 *  screen. Every git state had a pair like that: "Behind by 6 commits" /
 *  "6 commits behind remote", "Unpublished branch" / "Branch isn't published
 *  yet", "Up to date" / "In sync with remote".
 *
 *  The names come from here now, so there is one of each and a third surface
 *  can't fork them again. `count` is the commit or file count the state is
 *  about; states that don't carry one ignore it.
 *
 *  ── They were one vocabulary, and it was the wrong one ──────────────────
 *
 *  `ReviewState.label` has always been documented as "plain-language label for
 *  the bar (non-engineer audience)", and the bar that renders it is commented
 *  "state dot + plain-language label". Six of the eight were git: "Merge
 *  conflicts", "Merged", "Ready to merge", "Behind by 586 commits", "12 commits
 *  ahead", "Unpublished branch". The one thing the top of the review rail is
 *  for — telling you where your work stands — it said in the vocabulary of the
 *  tool underneath, to an audience the app is explicitly not built for.
 *
 *  So the label says what the state MEANS, and `branchStateDetail` keeps the
 *  precise git fact for the hover, where an engineer who wants "586 commits
 *  behind origin/main" still gets it. Nothing was dropped; it moved to the
 *  layer that wants it.
 *
 *  Two counts appear here and they are NOT the same unit, so they don't share a
 *  noun: an *update* is a commit ("586 updates from the team"), a *changed
 *  file* is a working-tree file ("15 changed files"). They used to both be
 *  "changes", which put "586 changes" and "15 changes" in one rail meaning
 *  wildly different things. */
export function branchStateLabel(id: ReviewStateId, count = 0): string {
  switch (id) {
    case "unknown":
      // Not a shade of any of the others. "We haven't looked" and "we looked
      // and nobody can see your work" are different sentences, and only one
      // of them is an accusation.
      return "Couldn’t check where this stands";
    case "conflicts":
      // Not "you broke something" — two people edited the same lines and
      // somebody has to choose. The fear this answers is "did I lose work?"
      return "Your changes clash with the team's";
    case "merged":
      return "This work is in";
    case "ready":
      return "Ready to go in";
    case "behind":
      return `Missing ${countOf(count, "update")} from the team`;
    case "ahead":
      return `${countOf(count, "update")} the team can't see yet`;
    case "unpublished":
      return "Nobody else can see this yet";
    case "uncommitted":
      // Deliberately NOT "not saved yet": the files are on disk, and telling
      // someone their work isn't saved when it is invents the exact panic the
      // plain wording is supposed to prevent. The count and the noun are the
      // whole state; the button beside it says what to do about it.
      return count > 0
        ? `${count} changed ${plural(count, "file")}`
        : "Changed files";
    case "clean":
      return "Up to date";
  }
}

/** The same state, said precisely, for the hover.
 *
 *  Every label above dropped a fact that someone who knows git will want back —
 *  which branch, which direction, how the number was counted. This is where it
 *  went. Both surfaces hang it off the row as a `title`, so the screen reads
 *  plainly and the detail is one hover away rather than gone. */
export function branchStateDetail(id: ReviewStateId, count = 0): string {
  switch (id) {
    case "unknown":
      return "Aura couldn’t read this branch against its remote, so nothing here says whether your commits are published.";
    case "conflicts":
      return "Merge conflicts: your commits and the remote's changed the same lines. Git can't pick a winner, so someone has to.";
    case "merged":
      return "The pull request for this branch was merged.";
    case "ready":
      return "The pull request is open, the branch is pushed, and there's nothing uncommitted.";
    case "behind":
      return `${countOf(count, "commit")} on the upstream branch that this one doesn't have yet.`;
    case "ahead":
      return `${countOf(count, "commit")} on this branch that haven't been pushed to the upstream yet.`;
    case "unpublished":
      return "This branch has no upstream. It exists only on this machine.";
    case "uncommitted":
      return count > 0
        ? `${countOf(count, "file")} in the working tree differ from the last commit.`
        : "The working tree differs from the last commit.";
    case "clean":
      return "In sync with the upstream branch, and nothing uncommitted.";
  }
}

/** The hover for an "↑3 ↓5" chip — the plain sentence first, the git fact
 *  under it.
 *
 *  Two chips render that pair of arrows (the branch switcher's row, the repo
 *  header's sync control) and each wrote its own title: "3 ahead · 5 behind
 *  upstream", "In step with upstream.", "This branch has no upstream — it only
 *  lives on your machine." So `branchStateLabel`'s doc claiming "there is one
 *  of each and a third surface can't fork them again" was already false when it
 *  was written — twice.
 *
 *  A chip whose visible form is two arrows and two numbers means nothing on its
 *  own, so unlike the rail rows the hover has to carry the MEANING, not just
 *  the mechanism. It carries both, meaning first, split by a newline. */
export function branchSyncDetail(
  ahead: number,
  behind: number,
  hasUpstream: boolean,
): string {
  const say = (id: ReviewStateId, n = 0) =>
    `${branchStateLabel(id, n)}\n${branchStateDetail(id, n)}`;
  if (!hasUpstream) return say("unpublished");
  if (ahead > 0 && behind > 0) {
    return [
      `${branchStateLabel("ahead", ahead)}. ${branchStateLabel("behind", behind)}.`,
      `${branchStateDetail("ahead", ahead)} ${branchStateDetail("behind", behind)}`,
    ].join("\n");
  }
  if (ahead > 0) return say("ahead", ahead);
  if (behind > 0) return say("behind", behind);
  return say("clean");
}

export function deriveReviewState(i: ReviewStateInput): ReviewState {
  const prState = (i.pr?.state ?? "").toLowerCase();
  const prOpen = i.pr != null && prState === "open";
  const prMerged = i.pr != null && prState === "merged";

  // 0. Nothing has come back yet. Every branch fact below is a placeholder,
  //    and the placeholder happens to spell "unpublished" — so this bar's
  //    first frame used to accuse the branch of being invisible to the team
  //    and put a Publish button under it. No action here: there is nothing to
  //    act on until we know something.
  if (!i.known) {
    return {
      id: "unknown",
      label: branchStateLabel("unknown"),
      detail: branchStateDetail("unknown"),
      tone: "neutral",
      primary: null,
      secondary: null,
    };
  }

  // 1. Merge conflicts dominate everything — the tree can't move until they
  //    are resolved.
  if (i.conflictsCount > 0) {
    return {
      id: "conflicts",
      label: branchStateLabel("conflicts"),
      detail: branchStateDetail("conflicts"),
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
      label: branchStateLabel("merged"),
      detail: branchStateDetail("merged"),
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
          label: branchStateLabel("ready"),
          detail: branchStateDetail("ready"),
          tone: "green",
          primary: { id: "merge", label: "Merge" },
          secondary: null,
        }
      : {
          id: "ready",
          label: `Open · #${i.pr!.number}`,
          detail: branchStateDetail("ready"),
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
      label: branchStateLabel("behind", i.behind),
      detail: branchStateDetail("behind", i.behind),
      tone: "amber",
      primary: { id: "pull", label: "Pull" },
      secondary: null,
    };
  }

  // 5. Ahead only → push.
  if (i.hasUpstream && i.ahead > 0) {
    return {
      id: "ahead",
      label: branchStateLabel("ahead", i.ahead),
      detail: branchStateDetail("ahead", i.ahead),
      tone: "neutral",
      primary: { id: "push", label: "Push" },
      secondary: null,
    };
  }

  // 6. No upstream → publish.
  if (!i.hasUpstream) {
    return {
      id: "unpublished",
      label: branchStateLabel("unpublished"),
      detail: branchStateDetail("unpublished"),
      tone: "neutral",
      primary: { id: "publish", label: "Publish" },
      secondary: null,
    };
  }

  // 7. Uncommitted working-tree changes with nothing else pending.
  if (i.changedCount > 0) {
    return {
      id: "uncommitted",
      label: branchStateLabel("uncommitted", i.changedCount),
      detail: branchStateDetail("uncommitted", i.changedCount),
      tone: "amber",
      primary: { id: "commit_push", label: "Commit and push" },
      secondary: null,
    };
  }

  // 8. Clean + in sync — a calm resting state, no tint, no action.
  return {
    id: "clean",
    label: branchStateLabel("clean"),
    detail: branchStateDetail("clean"),
    tone: "none",
    primary: null,
    secondary: null,
  };
}

// ── The repo header's one git button ────────────────────────────────────────

/** What a surface currently knows about the branch's relationship to its
 *  remote. Deliberately a union rather than `AheadBehind | null`: `null` was
 *  standing in for BOTH "the first read hasn't landed" and "the read threw",
 *  and both of those were then read as "no upstream". */
export type BranchRead =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      ahead: number;
      behind: number;
      hasUpstream: boolean;
    };

export type SyncActionKind =
  | "publish"
  | "push"
  | "pull"
  | "sync"
  | "fetch"
  | "wait"
  | "retry";

export type SyncAction = {
  kind: SyncActionKind;
  label: string;
  hint: string;
  /** True while there is nothing to act on — the button is inert rather than
   *  offering an action derived from facts we don't have. */
  idle: boolean;
};

/** The single right git action for the repo header, given what we know.
 *
 *  It lived in `RepoHeaderControls` and opened `if (!ab || !ab.has_upstream)
 *  return { kind: "publish", … }` — so before the first read returned, and
 *  after any read that threw, the header's primary git button read **Publish**
 *  over the hint "this branch only lives on your machine", and pressing it ran
 *  `git push --set-upstream` against a branch that may well have had one. It's
 *  here now because it is pure, and because a fold that decides which git
 *  command to run on your repo is worth a test. */
export function syncAction(read: BranchRead): SyncAction {
  if (read.status === "loading")
    return {
      kind: "wait",
      label: "Checking…",
      hint: "Reading where this branch stands against the shared copy.",
      idle: true,
    };
  if (read.status === "error")
    return {
      kind: "retry",
      label: "Try again",
      hint: `${branchStateDetail("unknown")}\n${read.message}`,
      idle: false,
    };
  if (!read.hasUpstream)
    return {
      kind: "publish",
      label: "Publish",
      hint: "This branch only lives on your machine. Publish it so teammates (and the server) can see it.",
      idle: false,
    };
  if (read.ahead > 0 && read.behind > 0)
    return {
      kind: "sync",
      label: "Sync",
      hint: "You have changes to send and changes to receive. Sync does both.",
      idle: false,
    };
  if (read.ahead > 0)
    return {
      kind: "push",
      label: "Push",
      hint: "Send your saved changes up to the shared copy.",
      idle: false,
    };
  if (read.behind > 0)
    return {
      kind: "pull",
      label: "Pull",
      hint: "Bring down changes others have shared.",
      idle: false,
    };
  return {
    kind: "fetch",
    label: "Check",
    hint: "You're in step with the shared copy. Check for anything new.",
    idle: false,
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
