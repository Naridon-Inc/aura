// A pull request's Overview: the page's pull request view — title, the one
// next step, the details list, the description, the feature it finishes,
// everything that happened to it and a box to comment — filled from GitHub
// and from Aura's own reads of the branch.

import { useEffect, useMemo, useState } from "react";
import { api, type GraphCommit, type PrComment, type PrDetail } from "../../../lib/api";
import { runGitChat } from "../../../lib/gitChat";
import { prApprove, prCommentPostIssue, prEdit, prUpdate, prWhoami } from "../../../lib/prApi";
import { commitsInPr } from "../../../lib/prFeature";
import type { PrDetailTab } from "../../../lib/editorStore";
import { relativeAge } from "../../../lib/relativeTime";
import { Composer } from "../../ui/composer";
import type { GitWorkflowAction } from "../../ui/git-workflow";
import { PullRequestView, type PullRequestDetails } from "../../ui/pull-request-view";
import { MessageMarkdown } from "../../ui/transcript-content";
import "../../ui/pr-overview.css";
import { requestPrMerge } from "../PrApprovalBar";
import { PrFeatureRollup } from "../PrFeatureRollup";
import {
  prActivity,
  prWorkflow,
  reviewerLabel,
  reviewThreads,
  saidComments,
  type PrChecksTally,
} from "./prOverviewModel";
import {
  AssigneesRow,
  ChecksRow,
  IssuesRow,
  LabelsRow,
  SafetyRow,
  StackRow,
  ThreadsRow,
} from "./PrOverviewRows";

// Deep enough to reach the merge-base for any realistic PR while staying cheap.
const GRAPH_LIMIT = 500;

function toast(kind: "success" | "error", text: string) {
  window.dispatchEvent(new CustomEvent("aura:toast", { detail: { kind, text, ttlMs: 6000 } }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PrOverview({
  repoRoot,
  detail,
  comments,
  checks,
  onOpenTab,
  onOpenFindings,
  onClose,
  onMutated,
  onCommentsChanged,
}: {
  repoRoot: string;
  detail: PrDetail;
  comments: PrComment[];
  checks: PrChecksTally | null;
  onOpenTab: (tab: PrDetailTab) => void;
  /** The Files tab with the safety check's findings beside the diff. */
  onOpenFindings: () => void;
  onClose: () => void;
  /** The PR changed on GitHub; re-read it. */
  onMutated: () => void;
  onCommentsChanged: () => void;
}) {
  const [viewer, setViewer] = useState("");
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const prNumber = detail.number;

  useEffect(() => {
    let alive = true;
    prWhoami(repoRoot)
      .then((who) => alive && setViewer(who))
      .catch(() => {
        /* unknown viewer: nobody is offered Approve */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // The branch's own commits, for the activity list. Only when both tips
  // are here to scope them — never a guess at which commits are the PR's.
  useEffect(() => {
    let alive = true;
    api
      .gitCommitGraph(repoRoot, GRAPH_LIMIT)
      .then((graph) => {
        if (!alive) return;
        const mine = commitsInPr(graph, detail.head_ref, detail.base_ref);
        setCommits(mine ? graph.filter((c) => mine.has(c.sha)) : []);
      })
      .catch(() => alive && setCommits([]));
    return () => {
      alive = false;
    };
  }, [repoRoot, detail.head_ref, detail.base_ref]);

  const workflow = useMemo(() => {
    const w = prWorkflow(detail, checks, viewer, comments);
    return busy ? { ...w, state: "working" as const } : w;
  }, [detail, checks, viewer, comments, busy]);

  const request: PullRequestDetails = useMemo(() => {
    const now = Date.now();
    return {
      number: prNumber,
      title: detail.title,
      author: detail.author,
      branch: detail.head_ref,
      targetBranch: detail.base_ref,
      description: detail.body,
      added: detail.additions,
      removed: detail.deletions,
      reviewers: detail.reviewers.map(reviewerLabel),
      activity: prActivity(detail, comments, commits).map((a) => ({
        id: a.id,
        author: a.author,
        message: a.message,
        sha: a.sha,
        kind: a.kind,
        time: relativeAge(a.at, { now, style: "prose" }),
        body: a.body ? <MessageMarkdown content={a.body} /> : undefined,
      })),
    };
  }, [detail, comments, commits, prNumber]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      onMutated();
    } catch (e) {
      toast("error", `${label} failed: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onAction = (action: GitWorkflowAction) => {
    switch (action) {
      case "ready-for-review":
        void act("Ready for review", () =>
          prEdit({
            repoRoot,
            prNumber,
            title: detail.title,
            body: detail.body,
            baseBranch: detail.base_ref,
            draft: false,
          }),
        );
        return;
      case "approve-pr":
        void act("Approve", () => prApprove(repoRoot, prNumber));
        return;
      case "merge":
        // Merging lives in the page's approval bar, with its strategy choice.
        requestPrMerge(repoRoot, prNumber);
        return;
      case "view-checks":
      case "view-logs":
        onOpenTab("checks");
        return;
      case "address-comments": {
        const said = saidComments(comments);
        // A new chat with every comment in it. A failed send is toasted.
        void runGitChat(repoRoot, `add-comments:${prNumber}`, {
          action: "add-comments",
          pr: { number: detail.number, title: detail.title },
          comments: said,
        });
        return;
      }
      case "archive":
        onClose();
        return;
      default:
        return;
    }
  };

  const onChange =
    detail.state === "OPEN"
      ? (next: PullRequestDetails) => {
          const title = next.title !== detail.title ? next.title : null;
          const body = next.description !== detail.body ? next.description : null;
          if (title == null && body == null) return;
          void act("Saving", () => prUpdate(repoRoot, prNumber, title, body));
        }
      : undefined;

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      await prCommentPostIssue(repoRoot, prNumber, body);
      setDraft("");
      onCommentsChanged();
    } catch (e) {
      toast("error", `Couldn't post the comment: ${message(e)}`);
    } finally {
      setPosting(false);
    }
  };

  const threads = reviewThreads(comments);
  return (
    <PullRequestView
      request={request}
      workflow={workflow}
      onChange={onChange}
      onAction={onAction}
      description={
        detail.body.trim() ? (
          <MessageMarkdown content={detail.body} />
        ) : (
          <p className="ui-pr-empty">No description.</p>
        )
      }
      details={
        <>
          <ChecksRow checks={checks} onView={() => onOpenTab("checks")} />
          <SafetyRow
            repoRoot={repoRoot}
            prNumber={prNumber}
            baseRef={detail.base_ref}
            review={detail.aura_review}
            reviewError={detail.aura_review_error ?? null}
            onViewFindings={onOpenFindings}
          />
          <ThreadsRow threads={threads} onOpen={() => onOpenTab("files")} />
          <LabelsRow repoRoot={repoRoot} prNumber={prNumber} />
          <StackRow repoRoot={repoRoot} prNumber={prNumber} />
          <IssuesRow issues={detail.related_issues} />
          <AssigneesRow assignees={detail.assignees} />
        </>
      }
      composer={
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void post()}
          disabled={posting}
          placeholder="Comment on this pull request…"
          sendKey="mod-enter"
        />
      }
    >
      {/* Is the thing this branch set out to build finished? Renders nothing
          until a proven goal is threaded to the PR's commits. */}
      <PrFeatureRollup repoRoot={repoRoot} headRef={detail.head_ref} baseRef={detail.base_ref} />
    </PullRequestView>
  );
}
