// The "Checks" tab: this workspace's pull request, and nothing else's. One
// workspace is one branch, and a branch has at most one pull request, so the
// tab is that PR's home.
//
// Top to bottom, and nothing under it: the PR's title; a short list of its
// branch, review, merge state and (when stacked) the PR it sits on; its
// description in a box of its own height; then "Git status", one flat list
// of what stands between the branch and a merge — uncommitted work, the
// remote, conflicts, CI, review, comments, the deployment — each row with
// the one thing that moves it on. Before there is a pull request: the same
// shape, with "No pull request yet" for a title and Create PR in the header.
// Every pull request in the repository is on the Dashboard, not here.
//
// Push, Pull and Merge run straight away. The rest — Commit and push,
// Resolve, Fix, Add to chat, Write or Update with Aura — open a new chat and
// send their message there (lib/gitChat), so the work streams where you can
// watch it and the chat you were in keeps its thread.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AheadBehind, PrComment, PrDetail, PrSummary } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { runGitChat, useGitChats } from "../../lib/gitChat";
import { usePrGuardFailure } from "../../lib/prGuards";
import { openPrGuardDetail } from "./prGuardDetail";
import { forgetBranchSync, gitFastForward, gitTargetSync } from "../../lib/branchSync";
import { fetchAheadBehind, fetchDiffStats, invalidateGitState } from "../../lib/gitStateCache";
import { openExternal } from "../../lib/openExternal";
import { gitFetch, gitPull, gitPush } from "../../lib/place/workApi";
import { toast } from "../../lib/toast";
import { prUpdate } from "../../lib/prApi";
import { fetchPrComments } from "../../lib/prCommentsCache";
import { fetchPrDetail } from "../../lib/prDetailCache";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  pickBranchPr,
  subscribePrList,
} from "../../lib/prsCache";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { UPDATE_PR_HINT, updatePrJobId } from "../../lib/worktreeActions";
import { DetailsChecks } from "../ui/details-checks";
import { isIncompatible, mergeQueueText, mergeQueueUrl } from "./branchSyncRows";
import { checksTally, mergeLine, reviewersLine } from "./checksPrModel";
import { ChecksPrFacts } from "./ChecksPrFacts";
import { prStatusRows } from "./ChecksPrRows";
import { ChecksStackFact } from "./ChecksStackFact";
import { GitStatusRows, readyToMerge, type ChecksChats, type GitBusy } from "./ChecksStatus";
import { mergePullRequest } from "./prGitActions";
import { PrCreate, PrDescription, PrTitle, type PrJobAction } from "./PrDocument";
import { PULL_LATEST_JOB, pullLatestFromTarget } from "./pullLatest";
import { canOpenPr } from "./reviewWorkflow";
import { useBranchChecks } from "./useBranchChecks";
import { useBranchSync } from "./useBranchSync";

const POLL_MS = 6000;

type Props = {
  repoRoot: string;
  /** Live merge-conflict count (App scans sentinel + git markers). */
  conflictsCount: number;
  /** Kept for the caller's contract; "Commit and push" opens a chat rather
   *  than jumping the rail, so it is unused. */
  onGoToChanges?: () => void;
};

export function ChecksPanel({ repoRoot, conflictsCount }: Props) {
  const editor = useEditorStore();
  // `null` until a read lands: a zeroed struct would read as "never
  // published" and offer to publish a branch nobody had looked at.
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [readErr, setReadErr] = useState("");
  const [changedCount, setChangedCount] = useState(0);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [tick, setTick] = useState(0);
  const chat = useGitChats(repoRoot);
  const guard = usePrGuardFailure(repoRoot);
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function poll() {
      try {
        // Ahead/behind and the uncommitted count, both from git.
        const [a, d] = await Promise.all([
          fetchAheadBehind(repoRoot),
          fetchDiffStats(repoRoot).catch(() => null),
        ]);
        if (cancelled) return;
        setAb(a);
        setReadErr("");
        if (d) setChangedCount(d.changed_files);
      } catch (e) {
        if (cancelled) return;
        setReadErr(String(e).replace(/^Error:\s*/i, "").split("\n")[0]);
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

  useEffect(() => {
    let alive = true;
    void fetchPrList(repoRoot)
      .then((list) => alive && setPrs(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, tick]);
  useEffect(() => subscribePrList(repoRoot, setPrs), [repoRoot]);

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
  // The OPEN pull request for this branch wins (see `pickBranchPr`), so the
  // title edited here is the live PR's, not a superseded closed one.
  const pr = useMemo(() => pickBranchPr(prs, branch), [prs, branch]);
  const ci = useBranchChecks(repoRoot, pr?.number ?? null, tick);
  const { merge, sync } = useBranchSync(repoRoot, pr, tick);
  const [busy, setBusy] = useState<GitBusy>(null);

  useEffect(() => {
    if (!pr) {
      setDetail(null);
      return;
    }
    let alive = true;
    void fetchPrDetail(repoRoot, pr.number)
      .then((d) => alive && setDetail(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, pr?.number, tick]);

  useEffect(() => {
    if (!pr) {
      setComments([]);
      return;
    }
    let alive = true;
    void fetchPrComments(repoRoot, pr.number)
      .then((c) => alive && setComments(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, pr?.number, tick]);

  // Comments that carry prose (a bare approval has no body).
  const discussion = useMemo(() => comments.filter((c) => c.body.trim().length > 0), [comments]);

  const chats = useMemo<ChecksChats>(
    () => ({
      run: (id, req) => void runGitChat(repoRoot, id, req),
      sending: (id) => chat(id),
    }),
    [chat, repoRoot],
  );

  // Push, Pull and Merge run straight away; a failure says what failed and
  // why.
  const runGit = useCallback(
    async (state: Exclude<GitBusy, null>, work: () => Promise<unknown>, what: string) => {
      setBusy(state);
      try {
        await work();
        setTick((t) => t + 1);
        window.dispatchEvent(new CustomEvent("aura:git-changed"));
      } catch (e) {
        toast.danger(`${what} failed`, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  // "Pull" on "N commits behind main": a fast-forward runs here; a merge opens
  // a chat. Toasts say how it ended.
  const pullLatest = useCallback(async () => {
    if (!sync) return;
    setBusy("pulling-latest");
    try {
      const out = await pullLatestFromTarget(sync, {
        fetch: () => gitFetch(repoRoot),
        sync: () => {
          forgetBranchSync();
          return gitTargetSync(repoRoot, sync.target);
        },
        fastForward: (ref) => gitFastForward(repoRoot, ref),
        startChat: (req) => void runGitChat(repoRoot, PULL_LATEST_JOB, req),
        changedCount: async () => {
          invalidateGitState();
          return (await fetchDiffStats(repoRoot)).changed_files;
        },
      });
      if (out === "fast-forwarded") toast.success("Pulled latest changes. You're up to date!");
      setTick((t) => t + 1);
      window.dispatchEvent(new CustomEvent("aura:git-changed"));
    } catch (e) {
      toast.danger(`Pulling latest from remote failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [repoRoot, sync]);
  const git = {
    busy,
    pullLatest: () => void pullLatest(),
    push: () => void runGit("pushing", () => gitPush(repoRoot, !(ab?.has_upstream ?? false)), "Push"),
    pull: () => void runGit("pulling", () => gitPull(repoRoot), "Pull"),
  };

  const addCommentsId = pr ? `add-comments:${pr.number}` : "";
  const addAllToChat = useCallback(() => {
    if (!pr || discussion.length === 0) return;
    void runGitChat(repoRoot, `add-comments:${pr.number}`, {
      action: "add-comments",
      pr: { number: pr.number, title: pr.title },
      comments: discussion,
    });
  }, [pr, discussion, repoRoot]);

  // Save one field of the PR (gh pr edit); the other is left unchanged.
  const saveField = useCallback(
    async (patch: { title?: string; body?: string }) => {
      if (!pr) return;
      try {
        await prUpdate(repoRoot, pr.number, patch.title ?? null, patch.body ?? null);
        setTick((t) => t + 1);
        await invalidatePrList(repoRoot).catch(() => {});
      } catch (e) {
        console.error("[checks] prUpdate failed:", e);
      }
    },
    [pr, repoRoot],
  );

  // Write the PR's title and description from what's on the branch now —
  // "Write" while there's no description, "Update" once there is. It runs
  // when someone presses it; nothing re-runs it as work lands. The id is
  // shared with the PR tab's own button, so both show one send. A merged or
  // closed PR isn't rewritten.
  const prOpen = pr !== null && pr.state.toLowerCase() === "open";
  const updateId = pr ? updatePrJobId(pr.number) : null;
  const body = detail ? detail.body.trim() : null;
  const describe: PrJobAction | null =
    prOpen && updateId
      ? {
          label: body ? "Update with Aura" : "Write with Aura",
          running: chats.sending(updateId),
          hint: UPDATE_PR_HINT,
          onClick: () => {
            if (!pr) return;
            chats.run(updateId, { action: "update-pr", branch: pr.head_ref, prNumber: pr.number });
          },
        }
      : null;
  // No PR yet: Create PR and Create draft are the header's; the tab names
  // the branch and where it would go.
  const target = sync?.target || "main";

  // Merge sits with the pull request, offered only once the branch and GitHub
  // both agree nothing is left (see `readyToMerge`).
  const canMerge =
    readyToMerge(pr, ab, changedCount, conflictsCount, merge) && !isIncompatible(ab);
  const tally = pr ? checksTally(pr, ci.checks.state === "read" ? ci.checks.checks : null) : null;
  // Waiting in a merge queue is what the Merge row says, with the queue a
  // press away.
  const queue = prOpen ? (merge?.merge_queue_state ?? null) : null;
  const queueUrl = queue && pr?.url && merge?.base_ref ? mergeQueueUrl(pr.url, merge.base_ref) : null;
  const mergeFact = {
    label: queue ? mergeQueueText(queue) : tally ? mergeLine(detail, tally, comments, canMerge) : "",
    onOpenQueue: queueUrl ? () => void openExternal(queueUrl) : null,
    canMerge,
    merging: busy === "merging",
    onMerge: () => {
      if (pr) {
        void runGit("merging", () => mergePullRequest(repoRoot, pr.number, merge?.merge_method), "Merge");
      }
    },
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <DetailsChecks style={{ flexGrow: 1, flexBasis: 0 }}>
        <div className="ui-checks-doc">
          {pr ? (
            <>
              <PrTitle pr={pr} onSaveTitle={(title) => void saveField({ title })} />
              <ChecksPrFacts
                pr={pr}
                reviewers={reviewersLine(detail)}
                merge={mergeFact}
                onRequestReview={() => void openExternal(pr.url)}
                stack={<ChecksStackFact repoRoot={repoRoot} prNumber={pr.number} />}
              />
              <PrDescription body={body} onSaveBody={(b) => void saveField({ body: b })} action={describe} />
            </>
          ) : (
            branch && <PrCreate branch={branch} target={target} canOpen={canOpenPr(branch)} />
          )}
          <GitStatusRows
            ab={ab}
            readErr={readErr}
            changedCount={changedCount}
            conflictsCount={conflictsCount}
            pr={pr}
            merge={merge}
            sync={sync}
            chats={chats}
            git={git}
            prRows={
              pr
                ? prStatusRows({
                    pr,
                    checks: ci.checks,
                    deploy: ci.deploy,
                    chats,
                    comments: discussion.length,
                    onAddComments: addAllToChat,
                    addCommentsId,
                    onOpenPr: () => editor.openPrDetail(repoRoot, pr.number, pr.title, "overview"),
                    openExternal: (url) => void openExternal(url),
                  })
                : []
            }
            notice={guard ? { line: guard.line, onSeeWhy: () => openPrGuardDetail(guard.kind) } : null}
          />
        </div>
      </DetailsChecks>
    </div>
  );
}
