// The git status row at the top of the right sidebar: the pull request link,
// where the branch stands, and the one action that moves it forward (Commit
// and push, Push, Pull, Resolve, Create PR, Ready for review, Fix errors, Add
// all comments to chat, Merge, Archive).
//
// The lifecycle precedence lives in the pure `deriveReviewState`; the mapping
// onto the row's states lives in `workflowFor`. This file reads the branch and
// the pull request and runs the actions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { type AheadBehind, type PrSummary } from "../../lib/api";
import { fetchAheadBehind, fetchDiffStats } from "../../lib/gitStateCache";
import {
  fetchPrList,
  getPrListCached,
  getPrListError,
  pickBranchPr,
  retryPrList,
  subscribePrList,
} from "../../lib/prsCache";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { useOnline } from "../../lib/useOnline";
import { setWorkspaceArchived } from "../../lib/workspaceCustomization";
import { openExternal } from "../../lib/openExternal";
import { runGitChat, useGitChats } from "../../lib/gitChat";
import { useEditorStore } from "../../lib/editorStore";
import { gitPull, gitPush, gitRemoteOrigin } from "../../lib/place/workApi";
import { toast } from "../../lib/toast";
import { originToHttpBase } from "../../lib/worktreeActions";
import {
  GitWorkflowToolbar,
  type GitWorkflowAction,
  type GitWorkflowIssueAction,
} from "../ui/git-workflow";
import {
  addCommentsChatId,
  fixErrorsChatId,
  sendFailingChecks,
  sendPrComments,
  useSaidCommentCount,
} from "./prFixActions";
import { approvePullRequest, markReadyForReview, mergePullRequest } from "./prGitActions";
import { deriveReviewState } from "./reviewState";
import { canOpenPr, workflowFor, type WorkflowBusy } from "./reviewWorkflow";
import { prFetchIssue } from "./prFetchIssue";
import { useBranchSync } from "./useBranchSync";

const POLL_MS = 6000;

type Props = {
  repoRoot: string;
  /** Live merge-conflict count (App already scans sentinel + git markers). */
  conflictsCount: number;
  /** Switch the right rail to its Changes tab (for "Commit and push" and the
   *  merged "Continue" step). */
  onGoToChanges?: () => void;
};

export function ReviewStateHeader({ repoRoot, conflictsCount, onGoToChanges }: Props) {
  // `null` until a read lands. A zeroed AheadBehind is a valid answer meaning
  // "published nowhere", so seeding with one made the first frame offer to
  // publish a branch nothing had looked at.
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [changedCount, setChangedCount] = useState(0);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [origin, setOrigin] = useState("");
  // Why the last read of the pull requests failed; cleared by the next one
  // that lands. Re-read on focus and after every git change.
  const [prErr, setPrErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<WorkflowBusy>(null);
  const chats = useGitChats(repoRoot);
  const editor = useEditorStore();
  const [tick, setTick] = useState(0);
  const visible = useDocumentVisibility();
  const online = useOnline();

  // Poll ahead/behind + the uncommitted count (uncommitted-vs-HEAD, so a
  // worktree's since-base diff never reads as uncommitted work).
  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function poll() {
      try {
        const [a, d] = await Promise.all([
          fetchAheadBehind(repoRoot),
          fetchDiffStats(repoRoot).catch(() => null),
        ]);
        if (cancelled) return;
        setAb(a);
        if (d) setChangedCount(d.changed_files);
      } catch {
        // Transient — keep the last-known state, or `null` ("Loading status")
        // when there is none. Never fall back to a zeroed read.
      }
    }
    void poll();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible, tick]);

  // PR list — SWR cache, shared with the Checks tab (no double-fetch).
  useEffect(() => {
    let alive = true;
    void fetchPrList(repoRoot)
      .then((list) => {
        if (!alive) return;
        setPrs(list);
        // A stale list comes back while its refresh failed: keep saying so.
        setPrErr(getPrListError(repoRoot));
      })
      .catch((e) => {
        if (alive) setPrErr(e instanceof Error ? e.message : String(e));
      });
    gitRemoteOrigin(repoRoot)
      .then((o) => {
        if (alive) setOrigin(o || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, tick]);
  useEffect(
    () =>
      subscribePrList(repoRoot, (list) => {
        setPrs(list);
        setPrErr(getPrListError(repoRoot));
      }),
    [repoRoot],
  );

  // Re-poll on any git mutation elsewhere, and when the window regains focus
  // (a push may have happened in a terminal).
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("aura:git-changed", bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("aura:git-changed", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const branch = ab?.branch ?? null;
  // Prefers the OPEN pull request for this branch: the cache holds every
  // state, and a superseded closed one must not decide the row.
  const pr = useMemo(() => pickBranchPr(prs, branch), [prs, branch]);
  const { merge, sync } = useBranchSync(repoRoot, pr, tick);
  // "Add all comments to chat" shows once there are comments to add.
  const saidCount = useSaidCommentCount(
    repoRoot,
    pr?.number ?? null,
    pr?.review_decision === "CHANGES_REQUESTED",
    tick,
  );

  const review = useMemo(
    () =>
      deriveReviewState({
        known: ab !== null,
        ahead: ab?.ahead ?? 0,
        behind: ab?.behind ?? 0,
        hasUpstream: ab?.has_upstream ?? false,
        changedCount,
        conflictsCount,
        pr: pr
          ? { number: pr.number, state: pr.state, reviewDecision: pr.review_decision }
          : null,
        // `prMerge` exists, so Merge is a real capability here.
        canMerge: true,
      }),
    [ab, changedCount, conflictsCount, pr],
  );

  // An agent-run action keeps the row busy while its chat's message goes
  // out; the local flag covers the inline git calls.
  const handingOff =
    pr != null && (chats(fixErrorsChatId(pr.number)) || chats(addCommentsChatId(pr.number)));
  const jobBusy: WorkflowBusy = chats("create-pr")
    ? "creating-pr"
    : chats("commit-push") || chats("resolve") || chats("incompatible") || handingOff
      ? "working"
      : null;

  const derived = workflowFor({
    review,
    pr: pr
      ? {
          number: pr.number,
          url: pr.url,
          state: pr.state,
          isDraft: pr.is_draft,
          baseRef: pr.base_ref,
          reviewDecision: pr.review_decision,
          checks:
            pr.checks_total > 0
              ? { total: pr.checks_total, failing: pr.checks_failing, pending: pr.checks_pending }
              : null,
        }
      : null,
    branch,
    ahead: ab?.ahead ?? 0,
    behind: ab?.behind ?? 0,
    changedCount,
    busy: busy ?? jobBusy,
    merge,
  });
  const shown =
    derived.state === "changes-requested"
      ? { ...derived, hasPendingComments: (saidCount ?? 0) > 0 }
      : derived;
  // While an action runs the row shows it, not a stale read's warning.
  const issue =
    (busy ?? jobBusy) ? null : prFetchIssue({ reason: prErr, showingPr: pr !== null, origin, online });
  const workflow = issue
    ? {
        ...shown,
        issue,
        label: issue.replacesLabel ? issue.title : shown.label,
        warningTone: issue.replacesLabel,
      }
    : shown;

  const afterMutation = useCallback(() => {
    setTick((t) => t + 1);
    window.dispatchEvent(new CustomEvent("aura:git-changed"));
  }, []);

  const goToChanges = useCallback(() => {
    onGoToChanges?.();
    window.dispatchEvent(new CustomEvent("aura:focus-changes"));
  }, [onGoToChanges]);

  const runGit = useCallback(
    async (state: Exclude<WorkflowBusy, null>, work: () => Promise<unknown>, what: string) => {
      setBusy(state);
      try {
        await work();
        afterMutation();
      } catch (e) {
        toast.danger(`${what} failed`, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [afterMutation],
  );

  const onAction = useCallback(
    (action: GitWorkflowAction) => {
      switch (action) {
        case "commit-push":
          // The agent writes the commit message, in a chat you can watch.
          void runGitChat(repoRoot, "commit-push", { action: "commit-push" });
          return;
        case "push":
          void runGit("pushing", () => gitPush(repoRoot, !(ab?.has_upstream ?? false)), "Push");
          return;
        case "pull":
          void runGit("pulling", () => gitPull(repoRoot), "Pull");
          return;
        case "resolve-conflicts":
          // The same id the Checks tab uses, so both show one send. With none
          // in the checkout, the conflicts are GitHub's, against the pull
          // request's base.
          void runGitChat(
            repoRoot,
            "resolve",
            conflictsCount === 0 && merge?.merge_state_status === "DIRTY"
              ? { action: "resolve-conflicts", target: merge.base_ref || pr?.base_ref || "main" }
              : { action: "resolve-local-conflicts" },
          );
          return;
        case "sync":
          void runGitChat(repoRoot, "incompatible", { action: "resolve-incompatible" });
          return;
        case "create-pr":
        case "create-draft-pr":
          if (!branch) return;
          void runGitChat(repoRoot, "create-pr", {
            action: "create-pr",
            branch,
            remote: sync?.remote || "origin",
            target: pr?.base_ref || sync?.target || "main",
            draft: action === "create-draft-pr",
          });
          return;
        case "create-pr-manually": {
          const base = originToHttpBase(origin);
          if (base && branch) void openExternal(`${base}/compare/${encodeURIComponent(branch)}?expand=1`);
          return;
        }
        case "fix-checks":
          // A new chat gets the failing checks and fixes them in this branch.
          if (pr) void sendFailingChecks(repoRoot, pr.number);
          return;
        case "address-comments":
          if (pr) void sendPrComments(repoRoot, { number: pr.number, title: pr.title });
          return;
        case "approve-pr":
          if (!pr) return;
          void runGit("working", () => approvePullRequest(repoRoot, pr.number), "Approve");
          return;
        case "ready-for-review":
          if (!pr) return;
          void runGit("working", () => markReadyForReview(repoRoot, pr.number), "Ready for review");
          return;
        case "merge":
          if (!pr) return;
          void runGit(
            "merging",
            () => mergePullRequest(repoRoot, pr.number, merge?.merge_method),
            "Merge",
          );
          return;
        case "archive":
          setWorkspaceArchived(repoRoot, true);
          return;
        case "continue":
          if (onGoToChanges) goToChanges();
          else if (pr) void openExternal(pr.url);
          return;
        default:
          return;
      }
    },
    [repoRoot, ab, branch, origin, pr, merge, sync, conflictsCount, onGoToChanges, goToChanges, runGit],
  );

  const onIssueAction = useCallback(
    (action: GitWorkflowIssueAction) => {
      if (action === "retry") {
        void retryPrList(repoRoot)
          .then((list) => {
            setPrs(list);
            setPrErr(null);
          })
          .catch((e) => setPrErr(e instanceof Error ? e.message : String(e)));
        return;
      }
      window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "git" } }));
    },
    [repoRoot],
  );

  // On a default branch there is no pull request to open: the row still says
  // where things stand, with its Create PR button off.
  // Nor when the pull requests couldn't be read: one may well exist.
  const actionable =
    workflow.state !== "no-pr" || (canOpenPr(branch) && !(issue && !pr));

  return (
    <div className="ui-details-header">
      <GitWorkflowToolbar
        workflow={workflow}
        onAction={actionable ? onAction : undefined}
        onOpenPr={pr ? () => editor.openPrDetail(repoRoot, pr.number, pr.title) : undefined}
        onOpenExternal={pr ? () => void openExternal(pr.url) : undefined}
        onIssueAction={onIssueAction}
      />
    </div>
  );
}
