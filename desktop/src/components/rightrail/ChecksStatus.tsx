// The Checks tab's Git status list — where the branch and its pull request
// stand, one row each, with the one thing that moves it on at the row's end.
// In this order: uncommitted work; behind or ahead of the remote (or not
// published, or gone a different way from it); behind the target branch;
// conflicts; then the pull request's own rows (ChecksPrRows: failed checks,
// running and passed checks, changes requested, comments, the deployment);
// last a note from the last Create PR. With nothing to say the list is not
// drawn at all. Draft, the merge queue and waiting on review are the header's
// and the Merge and Review rows' to say, so they aren't said twice here.
//
// Push and Pull run git straight away; so does pulling the target in when it
// is a fast-forward. Commit and push and Resolve open a new chat and send
// their message there (lib/gitChat), so the work runs where you can watch it.

import type { ReactElement } from "react";
import { CircleAlert, CircleDashed } from "lucide-react";

import type { AheadBehind, PrSummary } from "../../lib/api";
import type { PrMergeState, TargetSync } from "../../lib/branchSync";
import type { GitChatRequest } from "../../lib/gitChatPrompts";
import { DetailsCheckList, DetailsCheckRow } from "../ui/details-checks";
import { DetailsCaption } from "../ui/details-panel";
import {
  hasTargetConflicts,
  INCOMPATIBLE_HINT,
  INCOMPATIBLE_TITLE,
  isIncompatible,
  mergeStateAllows,
  pullLatestHint,
  pullLatestTitle,
  showPullLatest,
  TARGET_CONFLICTS_HINT,
} from "./branchSyncRows";
import { branchStateDetail, branchStateLabel } from "./reviewState";

export type ChecksChats = {
  /** Open the action's chat; the id names the row it belongs to. */
  run: (id: string, req: GitChatRequest) => void;
  /** Whether that row's message is going out. */
  sending: (id: string) => boolean;
};

/** Which direct git or GitHub action is in flight, if any. */
export type GitBusy = "pushing" | "pulling" | "pulling-latest" | "merging" | "marking" | null;

export type GitStatusActions = {
  busy: GitBusy;
  push: () => void;
  pull: () => void;
  /** Bring the target branch in ("N commits behind main"). */
  pullLatest: () => void;
};

/** Whether the pull request can go in now: open, out of draft, its checks
 *  green, no review holding it, the branch level with its remote, and — once
 *  GitHub's merge state is read — GitHub agreeing and no queue holding it. */
export function readyToMerge(
  pr: PrSummary | null,
  ab: AheadBehind | null,
  changedCount: number,
  conflictsCount: number,
  merge: PrMergeState | null = null,
): boolean {
  if (!pr || pr.state.toLowerCase() !== "open" || pr.is_draft) return false;
  if (merge?.merge_queue_state || mergeStateAllows(merge) === false) return false;
  if (pr.checks_failing > 0 || pr.checks_pending > 0) return false;
  if (pr.review_decision === "CHANGES_REQUESTED" || pr.review_decision === "REVIEW_REQUIRED") {
    return false;
  }
  if (!ab || ab.ahead > 0 || ab.behind > 0) return false;
  return changedCount === 0 && conflictsCount === 0;
}

export function GitStatusRows({
  ab,
  readErr,
  changedCount,
  conflictsCount,
  pr,
  merge,
  sync,
  chats,
  git,
  prRows = [],
  notice = null,
}: {
  /** `null` until git has answered once. */
  ab: AheadBehind | null;
  readErr: string;
  changedCount: number;
  conflictsCount: number;
  pr: PrSummary | null;
  /** GitHub's merge state for the open pull request; `null` until read. */
  merge: PrMergeState | null;
  /** The branch against its target; `null` on a machine or with no target. */
  sync: TargetSync | null;
  chats: ChecksChats;
  git: GitStatusActions;
  /** The pull request's rows (ChecksPrRows), after the branch's own. */
  prRows?: ReactElement[];
  /** What failed underneath the last Create PR, in one sentence; null when it
   *  all passed. */
  notice?: { line: string; onSeeWhy: () => void } | null;
}) {
  // A row with an action is pending; "Working…" while its chat's message
  // goes out, then the chat carries the work.
  const act = (id: string, verb: string, req: GitChatRequest) => ({
    status: chats.sending(id) ? ("running" as const) : ("pending" as const),
    action: { label: verb, onClick: () => chats.run(id, req) },
  });
  // A direct action: "Working…" while it is in flight.
  const now = (busy: Exclude<GitBusy, null>, label: string, run: () => void) => ({
    status: git.busy === busy ? ("running" as const) : ("pending" as const),
    action: git.busy ? undefined : { label, onClick: run },
  });
  const open = pr !== null && pr.state.toLowerCase() === "open";
  const rows: ReactElement[] = [];
  const queue = open ? (merge?.merge_queue_state ?? null) : null;
  const targetConflicts = open && hasTargetConflicts(merge);
  const target = merge?.base_ref || pr?.base_ref || sync?.target || "main";

  if (changedCount > 0) {
    rows.push(
      <DetailsCheckRow
        key="uncommitted"
        {...act("commit-push", "Commit and push", { action: "commit-push" })}
        title={branchStateLabel("uncommitted", changedCount)}
        hint={branchStateDetail("uncommitted", changedCount)}
      />,
    );
  }
  // Nothing read yet, or the last read failed with nothing before it: say
  // so instead of guessing "unpublished".
  if (ab === null) {
    rows.push(
      <DetailsCheckRow
        key="unknown"
        status="pending"
        icon={<CircleDashed size={14} />}
        title={branchStateLabel("unknown")}
        hint={readErr ? `${branchStateDetail("unknown")}\n${readErr}` : branchStateDetail("unknown")}
      />,
    );
  } else if (!ab.has_upstream) {
    rows.push(
      <DetailsCheckRow
        key="unpublished"
        {...now("pushing", "Publish", git.push)}
        title={branchStateLabel("unpublished")}
        hint={branchStateDetail("unpublished")}
      />,
    );
  } else {
    if (ab.behind > 0) {
      rows.push(
        <DetailsCheckRow
          key="behind"
          {...now("pulling", "Pull", git.pull)}
          title={branchStateLabel("behind", ab.behind)}
          hint={branchStateDetail("behind", ab.behind)}
        />,
      );
    }
    // Uncommitted work goes up with "Commit and push"; Push waits for it.
    if (ab.ahead > 0 && changedCount === 0) {
      rows.push(
        <DetailsCheckRow
          key="ahead"
          {...now("pushing", "Push", git.push)}
          title={branchStateLabel("ahead", ab.ahead)}
          hint={branchStateDetail("ahead", ab.ahead)}
        />,
      );
    }
  }
  if (isIncompatible(ab)) {
    rows.push(
      <DetailsCheckRow
        key="incompatible"
        {...act("incompatible", "Resolve", { action: "resolve-incompatible" })}
        status={chats.sending("incompatible") ? "running" : "failed"}
        title={INCOMPATIBLE_TITLE}
        hint={INCOMPATIBLE_HINT}
      />,
    );
  }
  if (
    sync &&
    !queue &&
    showPullLatest({ sync, merge: open ? merge : null, ab, merged: pr?.state.toLowerCase() === "merged" })
  ) {
    rows.push(
      <DetailsCheckRow
        key="pull-latest"
        {...(chats.sending("pull-latest")
          ? { status: "running" as const }
          : now("pulling-latest", "Pull", git.pullLatest))}
        title={pullLatestTitle(sync)}
        hint={pullLatestHint(sync)}
      />,
    );
  }
  if (conflictsCount > 0 || targetConflicts) {
    // Conflicts in the checkout come first: they are what's in the way now.
    const local = conflictsCount > 0;
    rows.push(
      <DetailsCheckRow
        key="merge-conflicts"
        {...act(
          "resolve",
          "Resolve",
          local ? { action: "resolve-local-conflicts" } : { action: "resolve-conflicts", target },
        )}
        status={chats.sending("resolve") ? "running" : "failed"}
        title={branchStateLabel("conflicts")}
        hint={local ? branchStateDetail("conflicts") : TARGET_CONFLICTS_HINT(target)}
      />,
    );
  }
  rows.push(...prRows);

  if (notice) {
    // Quiet on purpose: a note, not a failed step. The pull request opened.
    rows.push(
      <DetailsCheckRow
        key="pr-guard"
        status="pending"
        icon={<CircleAlert size={14} />}
        title={notice.line}
        action={{ label: "See why", onClick: notice.onSeeWhy }}
      />,
    );
  }

  if (rows.length === 0) return null;
  return (
    <section className="ui-checks-status">
      <DetailsCaption>Git status</DetailsCaption>
      <DetailsCheckList flat>{rows}</DetailsCheckList>
    </section>
  );
}
