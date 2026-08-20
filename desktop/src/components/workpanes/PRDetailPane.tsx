// PR Detail pane — Stage 7A. Singleton WorkSurface body that renders
// the currently-selected PR (per `editorStore.selectedPr`).
//
// Layout (4 columns):
//   1. File tree (left, ~16%)        — files changed, with adds/dels
//   2. Diff viewer (middle, ~50%)    — unified diff for the selected file
//   3. Threads (right top, ~17%)     — placeholder until 7B
//   4. Semantic findings (right bot) — `.aura/reviews/*.json` overlay
//
// Header surfaces PR number, title, author, head→base branches, state,
// risk chip, action buttons (open-on-github, refresh). Action buttons
// for Approve / Request Changes / Merge land in 7D.
//
// Diff rendering: the unified-diff body from `gh pr diff <num>` is
// split per-file on `diff --git` headers. Selected file's hunk is
// rendered as colour-classified <pre> lines (+ green / - red / @@
// blue / context dim). For v1 this is simpler than wiring a real
// MergeView per-file (each file would need a `gh pr diff -- <path>`
// fetch); ships now, can upgrade later.

import { useCallback, useEffect, useMemo, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { shortDateFromSecs } from "../../lib/calendarDate";
import { monogram } from "../../lib/monogram";
import { AlertTriangle, ShieldCheck, SquareArrowOutUpRight } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  type AuraChangeIntent,
  type AuraHumanFinding,
  type PrComment,
  type PrDetail,
  type PrFileStat,
} from "../../lib/api";
import { fetchPrList } from "../../lib/prsCache";
import { humanizeFindingText } from "../../lib/humanizeFinding";
import {
  noFindingsLine,
  prReviewState,
  prReviewTotal,
} from "../../lib/prReviewState";
import { EmptyState, ErrorState } from "../ui/state";
import {
  fetchPrDetail,
  getPrDetailCached,
  invalidatePrDetail,
  subscribePrDetail,
} from "../../lib/prDetailCache";
import {
  fetchPrComments,
  getPrCommentsCached,
  invalidatePrComments,
  subscribePrComments,
} from "../../lib/prCommentsCache";
import { useEditorStore } from "../../lib/editorStore";
import { startAuraJob, useAuraJobs } from "../../lib/auraJob";
import {
  updatePrJobId,
  updatePrPrompt,
  UPDATE_PR_HINT,
} from "../../lib/worktreeActions";
import { PrApprovalBar } from "../pr/PrApprovalBar";
import { PrStackView } from "../pr/PrStackView";
import { PrOverviewTab } from "../pr/PrOverviewTab";
import { PrChecksTab } from "../pr/PrChecksTab";
import { PrDiffBody, groupThreads } from "../pr/PrDiffBody";
import {
  PrThreadColumn,
  PrThreadProvider,
  usePrThreadRegister,
} from "../pr/PrThreadColumn";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs, type WizardStepMeta } from "../ui/wizard";
import { Segment } from "../ui/segment";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { MARKDOWN_COMPONENTS } from "../pr/PrDescriptionCard";
import { GhErrorNotice } from "../github/GhErrorNotice";
import { requestPrAuthoring } from "../dialogs/PrAuthoringDialog";
import { Churn } from "../diff/Churn";
import { detectLanguage } from "../../lib/fileLang";
import { SplitDiffHeader, useStackedDiff } from "./SplitDiffHeader";
import {
  fetchChangeNoteReport,
  resolvePrRange,
} from "../../lib/changeNoteCache";
import type { FileChangeNote } from "../../lib/api";
import { relativeAgeFromIso } from "../../lib/relativeTime";

type Props = {
  onClose: () => void;
  /** Override the editor-store PR selection — set when this pane renders a
   *  specific PR standalone (e.g. detached into its own popout window) rather
   *  than tracking the main window's `selectedPr`. */
  selOverride?: { repoRoot: string; number: number };
  /** Render in-flow (no modal portal/backdrop) for a detached popout window. */
  embedded?: boolean;
  /** When provided, surfaces a "detach to window" action in the header. */
  onDetach?: () => void;
};

type RightTab = "threads" | "stack" | "findings";
type TopTab = "overview" | "files" | "checks" | "conversation";

// Main header tabs — driven through the shared WizardStepTabs (variant="tabs")
// so the PR detail header reads identically to the create-task wizard. The
// strip is non-sequential (every tab always jumpable); we map the string TopTab
// keys to the numeric index WizardStepTabs expects via TOP_TAB_IDS.
const TOP_TABS: WizardStepMeta[] = [
  { id: "overview", label: "Overview", icon: <OverviewIcon /> },
  { id: "files", label: "Files", icon: <FilesIcon /> },
  { id: "checks", label: "Checks", icon: <ChecksIcon /> },
  { id: "conversation", label: "Conversation", icon: <ChatIcon /> },
];
const TOP_TAB_IDS = TOP_TABS.map((t) => t.id) as TopTab[];

export function PRDetailPane({ onClose, selOverride, embedded = false, onDetach }: Props) {
  const editor = useEditorStore();
  // A detached popout window seeds its PR via `selOverride`; the in-app
  // singleton tracks the editor store's current selection.
  const sel = selOverride ?? editor.selectedPr;
  // Live background jobs for this repo. The PR you are READING is the one this
  // pane can update with Aura, and `updatePrJobId` scopes the run to that PR —
  // so the review rail and the header's Update button light up with this one
  // when they mean the same pull request, and ignore it when they don't.
  const job = useAuraJobs(sel?.repoRoot ?? "");
  const [data, setData] = useState<PrDetail | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [loading, setLoading] = useState(true);
  // SWR pip — bg-refresh-in-flight indicator while warm content is on
  // screen.
  const [refreshing, setRefreshing] = useState(false);
  // After 300ms with no cached content, swap the skeleton for textual
  // status + a Cancel so a wedged fetch is escapable.
  const [slowLoad, setSlowLoad] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("threads");
  const [topTab, setTopTab] = useState<TopTab>("overview");
  const [, setLastSeenAt] = useState<string | null>(null);
  // #213 — per-file "Viewed" state for the Files tab, keyed identically
  // to the Overview tab's PrFileDiffCard (`aura.pr.<root>.<num>.viewed.<path>`)
  // so toggling Viewed in one surface reflects in the other. Held as a Set
  // (not per-file localStorage reads on render) so the FileTree can paint a
  // check on viewed rows and the diff header toggle stays in sync.
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(() => new Set());
  const viewedKey = useCallback(
    (path: string) =>
      sel ? `aura.pr.${sel.repoRoot}.${sel.number}.viewed.${path}` : "",
    [sel?.repoRoot, sel?.number],
  );
  const toggleViewed = useCallback(
    (path: string, val: boolean) => {
      setViewedPaths((prev) => {
        const next = new Set(prev);
        if (val) next.add(path);
        else next.delete(path);
        return next;
      });
      try {
        const k = viewedKey(path);
        if (k) localStorage.setItem(k, val ? "1" : "0");
      } catch {
        // localStorage can fail in private browsing — Viewed is a hint, ignore.
      }
    },
    [viewedKey],
  );

  // Land on the sub-tab a caller requested via openPrDetail(..., initialTab) —
  // e.g. clicking a review comment in the Checks rail jumps straight here to
  // Conversation. A cold mount consumes the stashed value; an already-open tab
  // re-targeted live reacts to the event. (Mirrors the tasks edit handoff.)
  useEffect(() => {
    if (!sel) return;
    const tabId = `${sel.repoRoot}#${sel.number}`;
    const pending = editor.consumePendingPrDetailTab(tabId);
    if (pending) setTopTab(pending);
    const onTargetTab = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; tab: TopTab }>).detail;
      if (d && d.tabId === tabId) setTopTab(d.tab);
    };
    window.addEventListener("aura:pr-detail-tab", onTargetTab as EventListener);
    return () =>
      window.removeEventListener("aura:pr-detail-tab", onTargetTab as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.repoRoot, sel?.number]);

  const refresh = useCallback(
    async (force = false) => {
      if (!sel) return;
      const hasWarm = getPrDetailCached(sel.repoRoot, sel.number) != null;
      if (hasWarm) setRefreshing(true);
      setError(null);
      try {
        const detail = force
          ? await invalidatePrDetail(sel.repoRoot, sel.number)
          : await fetchPrDetail(sel.repoRoot, sel.number);
        setData(detail);
        if (!activePath && detail.files.length > 0) {
          setActivePath(detail.files[0].path);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      // activePath intentionally omitted — auto-select only on initial load
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [sel?.repoRoot, sel?.number],
  );

  const refreshComments = useCallback(
    async (force = false) => {
      if (!sel) return;
      try {
        const list = force
          ? await invalidatePrComments(sel.repoRoot, sel.number)
          : await fetchPrComments(sel.repoRoot, sel.number);
        setComments(list);
      } catch {
        // Comment fetch failures shouldn't blow away the rest of the
        // pane — gh's GraphQL endpoint sometimes 5xxs and we still want
        // diff + findings to render.
        setComments([]);
      }
    },
    [sel?.repoRoot, sel?.number],
  );

  // Reset activePath whenever the PR changes so we don't leak the
  // prior PR's selected file into the new PR's render. Seed from
  // cache so a revisit paints instantly instead of flashing the
  // "loading…" placeholder. Also bump the last-seen-at marker so the
  // unread-dot reflects what was new on the *previous* visit, then
  // write today's timestamp once we've rendered.
  useEffect(() => {
    setActivePath(null);
    if (!sel) {
      setData(null);
      setComments([]);
      setLastSeenAt(null);
      setLoading(false);
      return;
    }
    const cachedDetail = getPrDetailCached(sel.repoRoot, sel.number);
    const cachedComments = getPrCommentsCached(sel.repoRoot, sel.number);
    setData(cachedDetail);
    setComments(cachedComments ?? []);
    // No spinner if we have a cached payload — background SWR will
    // quietly refresh.
    setLoading(cachedDetail == null);
    if (cachedDetail && cachedDetail.files.length > 0) {
      setActivePath(cachedDetail.files[0].path);
    }
    const key = `aura.pr.${hashRoot(sel.repoRoot)}.${sel.number}.last_seen_at`;
    const prev = localStorage.getItem(key);
    setLastSeenAt(prev);
    const id = window.setTimeout(() => {
      localStorage.setItem(key, new Date().toISOString());
    }, 1500);
    return () => window.clearTimeout(id);
  }, [sel?.repoRoot, sel?.number]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Comments only render on the Conversation and Files tabs — fetch them
  // lazily when one of those is opened, not on every PR-open. A quick glance
  // at the Overview shouldn't spend a `gh` GraphQL call (and edge the API
  // toward its rate limit); warm-cache comments still paint instantly via the
  // reset effect above.
  const commentsNeeded = topTab === "conversation" || topTab === "files";
  useEffect(() => {
    if (commentsNeeded) void refreshComments();
  }, [commentsNeeded, refreshComments]);

  // #213 — hydrate the Viewed set from localStorage whenever the file
  // list lands (PR switch / first load) or the Files tab is (re)opened.
  // Reads the same per-file keys the Overview cards write, so a file
  // marked viewed on either tab shows as viewed on the other without a
  // PR reload.
  useEffect(() => {
    if (!sel || !data) {
      setViewedPaths(new Set());
      return;
    }
    const next = new Set<string>();
    for (const f of data.files) {
      try {
        if (
          localStorage.getItem(
            `aura.pr.${sel.repoRoot}.${sel.number}.viewed.${f.path}`,
          ) === "1"
        ) {
          next.add(f.path);
        }
      } catch {
        // ignore — private-browsing localStorage failure
      }
    }
    setViewedPaths(next);
  }, [data, sel?.repoRoot, sel?.number, topTab]);

  // Skeleton-to-textual swap timer for cold loads. Arms only while we
  // truly have no payload to render; warm-cache visits never see it.
  useEffect(() => {
    if (!loading || data) {
      setSlowLoad(false);
      return;
    }
    const id = window.setTimeout(() => setSlowLoad(true), 300);
    return () => window.clearTimeout(id);
  }, [loading, data, sel?.repoRoot, sel?.number]);

  // Reset cancel flag whenever the user navigates to a different PR.
  useEffect(() => {
    setCancelled(false);
  }, [sel?.repoRoot, sel?.number]);

  // Subscribe to cache updates so any other caller's refresh
  // (invalidations after mutations, background SWR from another
  // pane) flows into this pane without an extra fetch.
  useEffect(() => {
    if (!sel) return;
    const off1 = subscribePrDetail(sel.repoRoot, sel.number, (detail) => {
      setData(detail);
      setLoading(false);
      setRefreshing(false);
    });
    const off2 = subscribePrComments(sel.repoRoot, sel.number, (list) => {
      setComments(list);
    });
    return () => {
      off1();
      off2();
    };
  }, [sel?.repoRoot, sel?.number]);

  // ALL hooks must run before any early return — React tracks them by
  // call order, not name. Putting useMemo/useState/useEffect after the
  // `if (!sel) return …` guard makes the count differ across renders
  // when sel toggles, which crashes the reconciler with the classic
  // "rendered fewer hooks than expected" linked-list error.
  const fileChunks = useMemo(() => splitDiffByFile(data?.diff ?? ""), [data?.diff]);

  // CI checks live on PrSummary, not PrDetail (we only fetch them at
  // list time). Look them up from the current sidebar payload via a
  // light secondary fetch keyed off the selected PR — cheap because gh
  // caches the call.
  const [checks, setChecks] = useState<{
    state: string | null;
    passing: number;
    failing: number;
    pending: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    if (!sel) {
      setChecks(null);
      return;
    }
    let cancelled = false;
    fetchPrList(sel.repoRoot).then((list) => {
      if (cancelled) return;
      const me = list.find((p) => p.number === sel.number);
      if (!me) {
        setChecks(null);
        return;
      }
      setChecks({
        state: me.checks_state,
        passing: me.checks_passing,
        failing: me.checks_failing,
        pending: me.checks_pending,
        total: me.checks_total,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sel?.repoRoot, sel?.number]);

  const refreshAll = useCallback(() => {
    // Force-bypass cache here — refreshAll is the post-mutation hook
    // (approve/merge/comment-post) so we want a hot fetch, not a
    // possibly-stale cached value.
    void refresh(true);
    void refreshComments(true);
  }, [refresh, refreshComments]);

  // The plain-language change story for this pull request, read as ONE change
  // across base...head. Hooks can't sit below the `!sel` bail-out, so it runs
  // here and simply yields nothing until there's a PR to describe.
  const changeStory = usePrChangeStory(
    sel?.repoRoot ?? null,
    data?.base_ref ?? null,
    data?.head_ref ?? null,
  );
  // The diff column sits between a file tree and the thread rail, so it can be
  // narrow enough that Previous/New side by side stops being readable.
  const [diffColRef, diffColNarrow] = useStackedDiff();

  if (!sel) {
    return (
      <FullscreenOverlay onClose={onClose} embedded={embedded}>
        <div className="flex-1 flex items-center justify-center text-text-4 text-sm">
          No PR selected.
        </div>
      </FullscreenOverlay>
    );
  }

  const activeChunk = activePath ? (fileChunks.get(activePath) ?? "") : "";
  const activeFile = activePath
    ? (data?.files.find((f) => f.path === activePath) ?? null)
    : null;
  // What this file's change MEANS across the pull request, when the range
  // resolved and the engine had something to say about this particular file.
  const activeNote = activePath
    ? (changeStory.noteByPath.get(activePath) ?? null)
    : null;

  const riskChip =
    data?.aura_review?.risk_score !== undefined
      ? renderRiskChip(data.aura_review.risk_score, data.aura_review.risk_label)
      : null;
  const checksChip = checks?.state ? (
    <StatusChip
      dense
      tone={
        checks.state === "success"
          ? "green"
          : checks.state === "failure"
            ? "red"
            : "amber"
      }
      title={`CI ${checks.state}: ${checks.passing}✓ ${checks.failing}✗ ${checks.pending}…`}
    >
      ci {checks.passing}/{checks.total}
    </StatusChip>
  ) : null;

  return (
    <FullscreenOverlay
      onClose={onClose}
      embedded={embedded}
      tabs={
        <WizardStepTabs
          variant="tabs"
          steps={TOP_TABS.map((t) => {
            if (t.id === "conversation" && comments.length > 0)
              return { ...t, label: `Conversation (${comments.length})` };
            if (t.id === "checks" && checks && checks.failing > 0)
              return { ...t, label: `Checks (${checks.failing} failing)` };
            if (t.id === "checks" && checks && checks.total > 0)
              return { ...t, label: `Checks (${checks.total})` };
            return t;
          })}
          index={Math.max(0, TOP_TAB_IDS.indexOf(topTab))}
          onJump={(i) => setTopTab(TOP_TAB_IDS[i])}
        />
      }
      actions={
        <>
          {checksChip}
          {riskChip}
          {data?.reviewers && data.reviewers.length > 0 && (
            <ReviewerPips reviewers={data.reviewers} />
          )}
          {refreshing && (
            <AsciiSpinner className="text-sm" />
          )}
          {onDetach && (
            <Button
              variant="subtle"
              size="xs"
              onClick={onDetach}
              title="Detach to its own window"
            >
              <SquareArrowOutUpRight strokeWidth={1.75} aria-hidden />
              Detach
            </Button>
          )}
          {data && sel && data.state === "OPEN" && (
            <UpdateWithAuraButton
              repoRoot={sel.repoRoot}
              prNumber={sel.number}
              headRef={data.head_ref}
              running={
                job(updatePrJobId(sel.number))?.status === "running"
              }
            />
          )}
          {data && sel && data.state === "OPEN" && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() =>
                requestPrAuthoring({
                  mode: "edit",
                  repoRoot: sel.repoRoot,
                  number: sel.number,
                  title: data.title,
                  body: data.body,
                  baseBranch: data.base_ref,
                  draft: data.is_draft,
                })
              }
              title="Edit title, description, target branch, or draft state"
            >
              Edit
            </Button>
          )}
          <Button
            variant="subtle"
            size="xs"
            onClick={refreshAll}
            title="Refresh from gh"
          >
            Refresh
          </Button>
          {data?.url && (
            <Button variant="subtle" size="xs" asChild title="Open on GitHub">
              <a href={data.url} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>
                GitHub ↗
              </a>
            </Button>
          )}
        </>
      }
      footer={
        data && sel ? (
          <>
            {data.state === "OPEN" && (
              <Button
                variant="subtle"
                size="default"
                onClick={() => setTopTab("files")}
                title="Jump to the file diffs"
              >
                Review changes
              </Button>
            )}
            <PrApprovalBar
              repoRoot={sel.repoRoot}
              prNumber={sel.number}
              state={data.state}
              isDraft={data.is_draft}
              reviewDecision={data.review_decision}
              onMutated={refreshAll}
              failingChecks={checks?.failing ?? 0}
              pendingChecks={checks?.pending ?? 0}
            />
          </>
        ) : null
      }
    >
      {/* Body */}
      {loading && !data && cancelled ? (
        <div className="flex-1 flex items-center justify-center text-sm space-y-2 flex-col">
          <div className="text-text-4">Load cancelled.</div>
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              setCancelled(false);
              void refresh(true);
            }}
            className="text-text-2 hover:text-text-1 text-xs"
          >
            Retry
          </Button>
        </div>
      ) : loading && !data && slowLoad ? (
        <div className="flex-1 flex items-center justify-center flex-col gap-2">
          <div className="text-text-3 text-sm">Loading PR…</div>
          <Button
            variant="link"
            size="xs"
            onClick={() => setCancelled(true)}
            className="text-text-4 hover:text-text-2 text-xs"
          >
            Cancel
          </Button>
        </div>
      ) : loading && !data ? (
        <PrDetailSkeleton />
      ) : error ? (
        <GhErrorNotice
          error={error}
          align="center"
          onRetry={() => void refresh(true)}
        />
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center text-text-4 text-sm">
          No data.
        </div>
      ) : topTab === "overview" ? (
        <div className="flex-1 min-h-0">
          <PrOverviewTab
            repoRoot={sel.repoRoot}
            prNumber={sel.number}
            detail={data}
            checks={checks}
          />
        </div>
      ) : topTab === "checks" ? (
        <PrChecksTab repoRoot={sel.repoRoot} prNumber={sel.number} />
      ) : topTab === "conversation" ? (
        <PrConversation
          repoRoot={sel.repoRoot}
          prNumber={sel.number}
          detail={data}
          comments={comments}
          onPosted={() => void refreshComments(true)}
        />
      ) : (
        <PrThreadProvider
          repoRoot={sel.repoRoot}
          prNumber={sel.number}
          onPosted={() => {
            void refreshComments(true);
          }}
        >
          <div className="flex-1 min-h-0 flex">
            {/* File tree */}
            <FileTree
              files={data.files}
              activePath={activePath}
              onSelect={setActivePath}
              viewedPaths={viewedPaths}
            />

            {/* Diff */}
            <div className="flex-1 min-w-0 flex flex-col border-r border-line-soft">
              <FilesTabDiffHeader
                path={activePath}
                file={activeFile}
                viewed={activePath ? viewedPaths.has(activePath) : false}
                onToggleViewed={(v) => {
                  if (activePath) toggleViewed(activePath, v);
                }}
              />
              <div ref={diffColRef} className="flex-1 min-h-0 overflow-auto">
                {activePath ? (
                  <>
                    {/* MEANING FIRST, code second — the same order the Changes
                        tab uses for a commit. What this file's pieces do now,
                        what they used to do, and why, before a single line of
                        patch. Absent when the range can't be resolved on this
                        machine (an unfetched fork), in which case the diff
                        below is still the whole truth. */}
                    {changeStory.range && activeNote && (
                      <SplitDiffHeader
                        note={activeNote}
                        when={changeStory.when}
                        author={changeStory.author}
                        repoRoot={sel.repoRoot}
                        commit={changeStory.range}
                        stacked={diffColNarrow}
                      />
                    )}
                    <FluidDiff
                      repoRoot={sel.repoRoot}
                      prNumber={sel.number}
                      filePath={activePath}
                      body={activeChunk}
                      comments={comments}
                      onPosted={() => {
                        void refreshComments(true);
                      }}
                    />
                  </>
                ) : (
                  <div className="text-text-4 text-sm px-4 py-4">
                    Pick a file from the tree to see its diff.
                  </div>
                )}
              </div>
            </div>

            {/* Right column — floating thread popouts (Image #2 pattern)
                pinned to their diff line anchors via PrThreadColumn,
                plus the tabbed rail for stack / findings / threads
                fallback list. */}
            <div className="w-[340px] flex-shrink-0 flex flex-col relative">
              <RightTabs tab={rightTab} setTab={setRightTab} commentCount={comments.length} />
              {rightTab === "threads" && (
                <div className="flex-1 min-h-0 relative">
                  <PrThreadColumn />
                </div>
              )}
              {rightTab === "stack" && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <PrStackView repoRoot={sel.repoRoot} prNumber={sel.number} />
                </div>
              )}
              {rightTab === "findings" && <SemanticFindings detail={data} />}
            </div>
          </div>
        </PrThreadProvider>
      )}
    </FullscreenOverlay>
  );
}

/**
 * "Update with Aura" — the same job the review rail and the header button run,
 * offered where you actually read a pull request.
 *
 * Aura opens most of these PRs, and a PR it opened goes stale the moment more
 * work lands on the branch: the diff follows the branch head automatically, the
 * prose does not. So the title, the description, the blast-radius note and the
 * reviewer checklist keep describing the PR as it was on the day it opened. The
 * fix was already built — `updatePrPrompt` re-reviews the branch and rewrites
 * the PR to match what it does now — but it was only reachable from the review
 * rail, which is exactly the thing a PR tab takes off the screen.
 *
 * It runs on any open PR, not only Aura's. We don't record who opened a pull
 * request, and gating on provenance we'd have to guess at would hide the button
 * on half the PRs that need it. Rewriting a description to match the branch is
 * worth doing whoever opened it.
 */
function UpdateWithAuraButton({
  repoRoot,
  prNumber,
  headRef,
  running,
}: {
  repoRoot: string;
  prNumber: number;
  headRef: string;
  running: boolean;
}) {
  return (
    <Button
      variant="subtle"
      size="xs"
      disabled={running}
      onClick={() =>
        startAuraJob({
          repoRoot,
          id: updatePrJobId(prNumber),
          title: `Update pull request #${prNumber}`,
          text: updatePrPrompt(headRef, prNumber),
        })
      }
      title={UPDATE_PR_HINT}
    >
      {running ? (
        <>
          <AsciiSpinner className="text-2xs" />
          Updating…
        </>
      ) : (
        "Update with Aura"
      )}
    </Button>
  );
}

function hashRoot(root: string): string {
  // Cheap stable key — repo root absolute paths are long; we only need
  // collision-resistance within a single user's localStorage.
  let h = 5381;
  for (let i = 0; i < root.length; i++) {
    h = ((h << 5) + h + root.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function RightTabs({
  tab,
  setTab,
  commentCount,
}: {
  tab: RightTab;
  setTab: (t: RightTab) => void;
  commentCount: number;
}) {
  // The shared Segment control — one connected-cell pill track, same as the
  // right rail and everywhere else, instead of a bespoke underline strip. It
  // stretches to fill the narrow column; the Threads count folds into its label.
  return (
    <div className="flex-shrink-0 px-2 py-1.5">
      <Segment
        stretch
        size="sm"
        value={tab}
        onChange={setTab}
        ariaLabel="PR side panel"
        className="w-full"
        options={[
          {
            value: "threads",
            label:
              commentCount > 0 ? (
                <>
                  Threads
                  <span className="text-xs tabular-nums text-text-2">
                    {commentCount}
                  </span>
                </>
              ) : (
                "Threads"
              ),
          },
          { value: "stack", label: "Stack" },
          { value: "findings", label: "Findings" },
        ]}
      />
    </div>
  );
}

// ── Conversation tab ─────────────────────────────────────────────────
// A focused, single-column discussion timeline — distinct from Files
// (the diff browser). The PR body reads as the opening post, every
// issue/review comment follows in chronological order, and a composer
// at the foot posts a new conversation comment (api.prCommentPostIssue).

function PrConversation({
  repoRoot,
  prNumber,
  detail,
  comments,
  onPosted,
}: {
  repoRoot: string;
  prNumber: number;
  detail: PrDetail;
  comments: PrComment[];
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chronological merge: PR body first (the opening post), then every
  // comment by created_at. Review comments keep their file@line context.
  const timeline = useMemo(
    () =>
      [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [comments],
  );

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.prCommentPostIssue(repoRoot, prNumber, text);
      setBody("");
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-4 py-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-text-1 leading-snug">
            {detail.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-3">
            <span className="tabular-nums">#{detail.number}</span>
            <span className="text-text-5">·</span>
            <span className="text-text-2">{detail.author}</span>
            <span className="text-text-5">·</span>
            <span className="font-mono text-xs text-text-3">
              {detail.head_ref} → {detail.base_ref}
            </span>
          </div>
        </div>

        <ConvEntry
          author={detail.author}
          createdAt={detail.created_at}
          body={detail.body}
          emptyBody="No description."
        />

        {timeline.map((c) => (
          <ConvEntry
            key={c.id}
            author={c.author}
            createdAt={c.created_at}
            body={c.body}
            context={
              c.is_issue_comment || !c.path
                ? undefined
                : `${c.path}${c.line != null ? `:${c.line}` : ""}`
            }
          />
        ))}

        {/* Composer — posts a conversation (issue-level) comment. */}
        <div className="flex gap-3 pt-1">
          <ConvAvatar author="" />
          <div className="flex-1 min-w-0">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Add a comment…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              {error && (
                <span className="mr-auto text-xs text-red-300 font-mono truncate">
                  {error}
                </span>
              )}
              <Button
                variant="accentSoft"
                size="sm"
                disabled={!body.trim() || busy}
                onClick={() => void submit()}
                className={error ? "" : "ml-auto"}
              >
                {busy ? "Posting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConvEntry({
  author,
  createdAt,
  body,
  context,
  emptyBody,
}: {
  author: string;
  createdAt: string;
  body: string;
  context?: string;
  emptyBody?: string;
}) {
  const empty = !body.trim();
  return (
    <div className="flex gap-3">
      <ConvAvatar author={author} />
      <div className="flex-1 min-w-0 rounded-lg border border-line-soft bg-bg-content overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 h-9 border-b border-line-soft/60 bg-bg-1/40">
          <span className="text-base font-medium text-text-1 truncate">
            {author || "you"}
          </span>
          <span className="text-sm text-text-4 flex-shrink-0">
            {relAge(createdAt)}
          </span>
          {context && (
            <span
              className="ml-auto font-mono text-xs text-text-4 truncate"
              title={context}
            >
              {context}
            </span>
          )}
        </div>
        <div className="px-3.5 py-3 text-base text-text-2 leading-[1.6]">
          {empty ? (
            <span className="text-text-4 italic">{emptyBody ?? "(empty)"}</span>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
              {body}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}

function ConvAvatar({ author }: { author: string }) {
  // One monogram for the whole app — see lib/monogram.
  const initial = monogram(author);
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      className="mt-0.5 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ backgroundColor: author ? `hsl(${hue}, 42%, 40%)` : "var(--color-bg-3)" }}
      title={author || "you"}
    >
      {initial}
    </span>
  );
}

// Compact relative-age label ("3h", "2d", "just now") for conversation
// rows. Self-contained so the Conversation tab needs no shared time util.
function relAge(iso: string): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromIso(iso, { style: "compact" });
}

// ── The pull request's change story ──────────────────────────────────

/** What a pull request did, per file, in words — the same account the Changes
 *  tab gives a commit, for the whole `base...head` range. */
type PrChangeStory = {
  /** The resolved range spec, or null while probing / when unresolvable. It is
   *  what the per-piece explanations key on, so it has to be the real one. */
  range: string | null;
  /** Per-file change notes by path. Empty until the engine answers. */
  noteByPath: Map<string, FileChangeNote>;
  /** The head commit's time and author — whose change this is, and when. */
  when: number | null;
  author: string | null;
};

const EMPTY_STORY: PrChangeStory = {
  range: null,
  noteByPath: new Map(),
  when: null,
  author: null,
};

/** Read a pull request as one change: which pieces it adds, changes and
 *  removes in each file, so the Files tab can say what it MEANS rather than
 *  only what text moved.
 *
 *  The engine already does this for a commit. A pull request is the same
 *  question asked of a range, so it is the same call with a range spec — which
 *  this resolves first, because a PR carries branch names and only some of
 *  those exist on this machine. Everything degrades to null: an unresolvable
 *  range, a repo without the engine, a PR against an unfetched fork all leave
 *  the tab exactly as it was, showing the diff and claiming nothing. */
function usePrChangeStory(
  repoRoot: string | null,
  baseRef: string | null,
  headRef: string | null,
): PrChangeStory {
  const [story, setStory] = useState<PrChangeStory>(EMPTY_STORY);
  useEffect(() => {
    setStory(EMPTY_STORY);
    if (!repoRoot || !baseRef || !headRef) return;
    let alive = true;
    void (async () => {
      const range = await resolvePrRange(repoRoot, baseRef, headRef);
      if (!alive || !range) return;
      // Start writing the words for EVERY file in this pull request now, while
      // the reader is still on the Overview tab — not one file at a time as
      // they click through the tree. Queues and returns; nothing awaits it.
      void api.prewarmChangeSummaries(repoRoot, range).catch(() => {});
      try {
        const report = await fetchChangeNoteReport(repoRoot, range);
        if (!alive) return;
        setStory({
          range,
          noteByPath: new Map(report.files.map((f) => [f.file, f])),
          when: report.commit_time ?? null,
          author: report.author?.trim() || null,
        });
      } catch {
        // No story for this PR — the diff below still stands on its own.
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoRoot, baseRef, headRef]);
  return story;
}

// ── File tree ────────────────────────────────────────────────────────

// #213 — GitHub-style per-file header for the Files tab's diff column.
// Mirrors the affordance the Overview cards (PrFileDiffCard) already
// carry — path · +adds/−dels · language · Viewed — so the two PR diff
// surfaces read identically. Viewed shares the Overview's localStorage
// keys (lifted into PRDetailPane), so a file is "viewed" in both places.
function FilesTabDiffHeader({
  path,
  file,
  viewed,
  onToggleViewed,
}: {
  path: string | null;
  file: PrFileStat | null;
  viewed: boolean;
  onToggleViewed: (val: boolean) => void;
}) {
  if (!path) {
    return (
      <div className="h-9 px-3 flex items-center border-b border-line-soft text-xs text-text-4 flex-shrink-0">
        (no file selected)
      </div>
    );
  }
  const language = detectLanguage(path);
  return (
    <div className="h-9 px-3 flex items-center gap-2.5 border-b border-line-soft flex-shrink-0">
      <span className="text-sm text-text-1 font-mono truncate" title={path}>
        {path}
      </span>
      {file && <Churn additions={file.additions} deletions={file.deletions} />}
      {language && <span className="text-xs text-text-4">{language}</span>}
      <label className="ml-auto flex items-center gap-1.5 text-sm text-text-3 cursor-pointer select-none flex-shrink-0">
        <input
          type="checkbox"
          checked={viewed}
          onChange={(e) => onToggleViewed(e.target.checked)}
          className="w-3.5 h-3.5 cursor-pointer"
          style={{ accentColor: "var(--color-accent)" }}
        />
        Viewed
      </label>
    </div>
  );
}

function FileTree({
  files,
  activePath,
  onSelect,
  viewedPaths,
}: {
  files: PrFileStat[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /** #213 — paths the user has marked Viewed; rendered with a check so the
   *  tree mirrors GitHub's "reviewed file" affordance. */
  viewedPaths: Set<string>;
}) {
  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [files]);
  const viewedCount = useMemo(
    () => files.reduce((n, f) => (viewedPaths.has(f.path) ? n + 1 : n), 0),
    [files, viewedPaths],
  );
  return (
    <div className="w-[260px] flex-shrink-0 border-r border-line-soft flex flex-col">
      <div className="section-label h-7 px-3 flex items-center border-b border-line-soft gap-2 flex-shrink-0">
        <span>Files</span>
        <span className="text-xs text-text-4 tabular-nums">{files.length}</span>
        {viewedCount > 0 && (
          <span
            className="text-2xs tabular-nums normal-case tracking-normal"
            style={{ color: "var(--color-accent)" }}
            title={`${viewedCount} of ${files.length} files viewed`}
          >
            {viewedCount}/{files.length} viewed
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs tabular-nums">
          <span className="text-green-400">+{totals.add}</span>
          <span className="text-red-400">−{totals.del}</span>
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {files.length === 0 ? (
          <div className="text-text-4 text-sm px-3 py-4">no files</div>
        ) : (
          files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelect(f.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-state-hover transition-colors text-left ${
                f.path === activePath ? "bg-state-selected" : ""
              }`}
              title={f.path}
            >
              {viewedPaths.has(f.path) ? (
                <ViewedCheck />
              ) : (
                <span className="w-3 flex-shrink-0" aria-hidden="true" />
              )}
              <span
                className={`text-sm font-mono truncate flex-1 ${
                  viewedPaths.has(f.path) ? "text-text-4" : "text-text-1"
                }`}
              >
                {f.path}
              </span>
              <span className="text-xs tabular-nums text-green-400">+{f.additions}</span>
              <span className="text-xs tabular-nums text-red-400">−{f.deletions}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// #213 — small check glyph marking a Viewed file in the tree, drawn in
// the app accent so it reads as "done" without an off-palette green.
function ViewedCheck() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      className="flex-shrink-0"
      style={{ color: "var(--color-accent)" }}
    >
      <path
        d="M2.5 6.2l2.2 2.3L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Split a unified-diff body into a map { path -> hunk text }. Each
// `diff --git a/X b/Y` boundary starts a new chunk; we use the b-side
// path as the key (matches `gh pr view --json files`).
function splitDiffByFile(body: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  type Hit = { idx: number; path: string };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    hits.push({ idx: m.index, path: m[2] });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx;
    const end = i + 1 < hits.length ? hits[i + 1].idx : body.length;
    out.set(hits[i].path, body.slice(start, end));
  }
  return out;
}

// ── Right column bits ────────────────────────────────────────────────

// ── Semantic findings (right rail) ───────────────────────────────────
// The Aura review JSON is a flat bag of free-text findings spread across a
// few fields. Rendered raw (the old version dumped each as a truncated
// monospace <li>) it degenerated into a wall of identical sentences — a
// historical engine bug emitted one "graph-neighborhood overlap" finding
// PER local branch, so a busy repo showed 100+ near-copies and the panel
// read as pure noise. This view: parses a severity off each line, collapses
// findings that differ only by the ref/branch they name into one row with a
// ×N count (the specifics drill down on demand), groups by severity, and
// draws on StatusChip + tokens instead of raw monospace.

type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const SEVERITY_TONE: Record<Severity, ChipTone> = {
  critical: "red",
  high: "amber",
  medium: "blue",
  low: "neutral",
  info: "neutral",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

type RawFinding = { category: string; defaultSev: Severity; text: string };

function collectRawFindings(
  review: NonNullable<PrDetail["aura_review"]>,
): RawFinding[] {
  const out: RawFinding[] = [];
  const push = (
    arr: string[] | undefined,
    category: string,
    defaultSev: Severity,
  ) => {
    for (const t of arr ?? []) {
      const text = t.trim();
      if (text) out.push({ category, defaultSev, text });
    }
  };
  push(review.invariant_violations, "Invariant", "high");
  push(review.cross_branch_conflicts, "Cross-branch", "medium");
  push(review.blast_radius, "Blast radius", "info");
  push(review.omni_graph_impact, "Cross-repo", "medium");
  push(review.taste_findings, "Taste", "low");
  return out;
}

// Plain-language label for the engine's internal finding categories, so the
// little tag on each finding row reads like English instead of compiler
// vocabulary. Matches the Safety check counters elsewhere ("Broken rules",
// "Ripple effects", "Branch clashes").
const CATEGORY_LABELS: Record<string, string> = {
  Invariant: "Broken rule",
  "Cross-branch": "Branch clash",
  "Blast radius": "Ripple effect",
  "Cross-repo": "Other repo",
  Taste: "Style",
};
function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// Categories whose findings are prose sentences from the engine (rule breaks,
// clashes) read better humanized and in a normal font; the rest are bare code
// identifiers (symbol names) that stay in mono.
function isProseCategory(category: string): boolean {
  return category === "Invariant" || category === "Cross-branch";
}

function normSeverity(token: string): Severity {
  const t = token.toLowerCase();
  if (t === "critical") return "critical";
  if (t === "high") return "high";
  if (t === "moderate" || t === "medium" || t === "med") return "medium";
  if (t === "low") return "low";
  return "info"; // info | note
}

function parseSeverity(raw: RawFinding): { severity: Severity; text: string } {
  const m = raw.text.match(
    /^\s*(critical|high|moderate|medium|med|low|info|note)\s*[:\-–—]\s*/i,
  );
  if (m) {
    return { severity: normSeverity(m[1]), text: raw.text.slice(m[0].length).trim() };
  }
  // No explicit prefix → category default, with a small escalation: a
  // deleted/removed protected node is critical, not merely "high".
  if (
    raw.category === "Invariant" &&
    /\b(delete|deleted|removed|protected node)\b/i.test(raw.text)
  ) {
    return { severity: "critical", text: raw.text };
  }
  return { severity: raw.defaultSev, text: raw.text };
}

// Collapse the variable tail of a finding so messages that differ only by
// the branch/ref they name fold into one template. "Graph-neighborhood
// overlap detected with branch aura/snapshot/x" → "Graph-neighborhood
// overlap detected". Falls back to the original when stripping would leave
// too little to read.
function genericLabel(text: string): string {
  const t = text
    .replace(/\bwith\s+branch\b.*$/i, "")
    .replace(/\b(on|against|with|branch|ref)\b[\s:'"]*[\w./-]+.*$/i, "")
    .replace(/aura\/snapshot\/[\w./-]+/gi, "")
    .replace(/[\s:–—-]+$/g, "")
    .trim();
  return t.length >= 6 ? t : text.trim();
}

type FindingGroup = {
  key: string;
  severity: Severity;
  category: string;
  label: string;
  items: string[];
  count: number;
};

function buildFindingGroups(
  review: NonNullable<PrDetail["aura_review"]>,
): FindingGroup[] {
  const map = new Map<string, FindingGroup>();
  for (const raw of collectRawFindings(review)) {
    const { severity, text } = parseSeverity(raw);
    const label = genericLabel(text);
    const key = `${raw.category}::${label.toLowerCase()}`;
    const g = map.get(key);
    if (!g) {
      map.set(key, {
        key,
        severity,
        category: raw.category,
        label,
        items: [text],
        count: 1,
      });
    } else {
      g.count += 1;
      if (!g.items.includes(text)) g.items.push(text);
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[g.severity]) {
        g.severity = severity;
      }
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );
}

function SemanticFindings({ detail }: { detail: PrDetail }) {
  const review = detail.aura_review;
  // What this panel is allowed to say, and when — see `prReviewState`. It used
  // to answer straight off `review`, which was `null` for four different
  // reasons, only one of which meant "there isn't one".
  const state = prReviewState({
    review,
    reviewError: detail.aura_review_error,
    base: detail.base_ref,
  });
  const groups = useMemo(
    () => (review && state.kind === "raw" ? buildFindingGroups(review) : []),
    [review, state.kind],
  );
  const total = prReviewTotal(state);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="section-label h-7 px-3 flex items-center border-b border-line-soft gap-2 flex-shrink-0">
        <span>Findings</span>
        {total > 0 && (
          <span className="text-xs text-text-4 tabular-nums">{total}</span>
        )}
        {/* The risk score counts findings — including the taste stream the
            bridge used to drop. Only show it beside a list we actually drew,
            so a score can never sit next to an empty panel again. */}
        {review && (state.kind === "humanized" || state.kind === "raw") && (
          <span className="ml-auto">
            <RiskChip label={review.risk_label} score={review.risk_score} />
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {state.kind === "failed" || state.kind === "unreadable" ? (
          <ErrorState size="md" title={state.title} message={state.message} />
        ) : state.kind === "absent" ? (
          <EmptyState
            size="md"
            icon={ShieldCheck}
            title={state.title}
            body={state.body}
          />
        ) : state.kind === "humanized" ? (
          <HumanizedReview
            summary={review?.summary}
            findings={review?.findings ?? []}
            changes={review?.changes ?? []}
            unverified={state.unverified}
          />
        ) : state.kind === "raw" ? (
          <FindingsList groups={groups} />
        ) : (
          <NoFindingsLine title={state.title} body={state.body} />
        )}
      </div>
    </div>
  );
}

/** The one place the app says a review turned up nothing — used by the raw
 *  fallback and by the humanized surface, so they can't drift into saying
 *  different things about the same review. */
function NoFindingsLine({
  title,
  body,
}: {
  title: string;
  body: string | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm text-text-3">
        {body ? <AlertTriangle size={13} className="text-amber" /> : <CleanCheckIcon />}
        {title}
      </div>
      {body && <p className="text-xs text-text-4 leading-relaxed pl-5">{body}</p>}
    </div>
  );
}

// ── Humanized review surface (engine `pr_humanize`) ─────────────────────────
// Plain-language summary + finding cards (what / why it matters / where / what
// to do) + a "Why these changes" intent list, so a non-developer can decide
// without reading the raw engine strings.

const HUMAN_SEVERITY_TONE: Record<AuraHumanFinding["severity"], ChipTone> = {
  critical: "red",
  warning: "amber",
  advisory: "blue",
  info: "neutral",
};
const HUMAN_SEVERITY_LABEL: Record<AuraHumanFinding["severity"], string> = {
  critical: "Must fix",
  warning: "Review",
  advisory: "Style",
  info: "FYI",
};
const HUMAN_SEVERITY_RANK: Record<AuraHumanFinding["severity"], number> = {
  critical: 0,
  warning: 1,
  advisory: 2,
  info: 3,
};

function HumanizedReview({
  summary,
  findings,
  changes,
  unverified,
}: {
  summary?: string;
  findings: AuraHumanFinding[];
  changes: AuraChangeIntent[];
  /** How many changed pieces the engine couldn't trace. Zero findings plus a
   *  non-zero count here is not a clean review, and this panel used to say it
   *  was. */
  unverified: number;
}) {
  const sorted = useMemo(
    () =>
      [...findings].sort(
        (a, b) => HUMAN_SEVERITY_RANK[a.severity] - HUMAN_SEVERITY_RANK[b.severity],
      ),
    [findings],
  );
  const withWhy = useMemo(() => changes.filter((c) => !!c.why), [changes]);
  const emptyLine = noFindingsLine(unverified);

  return (
    <div className="space-y-4">
      {summary && summary.trim() && (
        <p className="text-base leading-relaxed text-text-2">{summary.trim()}</p>
      )}

      {sorted.length > 0 ? (
        <div className="space-y-1.5">
          {sorted.map((f, i) => (
            <HumanFindingCard key={i} finding={f} />
          ))}
        </div>
      ) : (
        <NoFindingsLine title={emptyLine.title} body={emptyLine.body} />
      )}

      {withWhy.length > 0 && (
        <div className="pt-1">
          <div className="section-label mb-1.5">
            Why these changes
          </div>
          <div className="space-y-1.5">
            {withWhy.map((c, i) => (
              <WhyChangeRow key={i} change={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HumanFindingCard({ finding }: { finding: AuraHumanFinding }) {
  const tone = HUMAN_SEVERITY_TONE[finding.severity] ?? "neutral";
  const loc =
    finding.file && finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file ?? null;
  return (
    <div className="rounded-md border border-line-soft bg-bg-1/40 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <StatusChip tone={tone} dot dense>
          {HUMAN_SEVERITY_LABEL[finding.severity] ?? "FYI"}
        </StatusChip>
        <span className="flex-1 min-w-0 text-base font-medium text-text-1 leading-snug break-words">
          {finding.title}
        </span>
        {finding.count > 1 && (
          <span className="flex-shrink-0 text-2xs tabular-nums text-text-3 px-1.5 py-0.5 rounded-full bg-bg-2 border border-line-soft">
            ×{finding.count}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-text-2 break-words">
        {finding.detail}
      </p>
      {finding.suggestion && (
        <p className="mt-1 text-sm leading-relaxed text-accent break-words">
          → {finding.suggestion}
        </p>
      )}
      {loc && (
        <div className="mt-1 text-xs font-mono text-text-4 break-words">
          {loc}
        </div>
      )}
    </div>
  );
}

function WhyChangeRow({ change }: { change: AuraChangeIntent }) {
  const when =
    typeof change.when === "number" && change.when > 0
      ? shortDateFromSecs(change.when)
      : null;
  return (
    <div className="rounded-md border border-line-soft bg-bg-1/40 px-2.5 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-1 min-w-0 text-sm font-medium text-text-1 truncate">
          {change.file}
        </span>
        <span className="flex-shrink-0 text-xs text-text-4">{change.what}</span>
      </div>
      {change.why && (
        <p className="mt-1 text-sm leading-relaxed text-text-2 break-words">
          {change.why}
        </p>
      )}
      {(change.who || when) && (
        <div className="mt-1 text-xs text-text-4">
          {change.who ?? "—"}
          {when ? ` · ${when}` : ""}
        </div>
      )}
    </div>
  );
}

function RiskChip({ label, score }: { label: string; score: number }) {
  const norm = (label || "").toUpperCase();
  const tone: ChipTone =
    norm === "CRITICAL" ? "red" : norm === "MODERATE" ? "amber" : "green";
  const human =
    norm === "CRITICAL"
      ? "Critical"
      : norm === "MODERATE"
        ? "Moderate"
        : norm === "LOW"
          ? "Low"
          : label || "—";
  return (
    <StatusChip tone={tone} dot dense title={`risk score ${score}`}>
      {human}
    </StatusChip>
  );
}

function FindingsList({ groups }: { groups: FindingGroup[] }) {
  const bySeverity = useMemo(
    () =>
      SEVERITY_ORDER.map((sev) => ({
        sev,
        rows: groups.filter((g) => g.severity === sev),
      })).filter((s) => s.rows.length > 0),
    [groups],
  );
  return (
    <div className="space-y-3">
      {bySeverity.map(({ sev, rows }) => (
        <div key={sev}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <StatusChip tone={SEVERITY_TONE[sev]} dot dense>
              {SEVERITY_LABEL[sev]}
            </StatusChip>
            <span className="text-xs text-text-4 tabular-nums">
              {rows.reduce((n, r) => n + r.count, 0)}
            </span>
          </div>
          <div className="space-y-1">
            {rows.map((g) => (
              <FindingRow key={g.key} group={g} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingRow({ group }: { group: FindingGroup }) {
  const [open, setOpen] = useState(false);
  // Only collapsible when the row folded multiple distinct messages —
  // otherwise the ×N is just a repeat count and there's nothing to drill.
  const drillable = group.items.length > 1;
  // A single finding shows its full text (the generic label could have
  // stripped a meaningful "… with …" tail); a folded group shows the shared
  // template, with the specifics in the drill-down.
  const prose = isProseCategory(group.category);
  const rawDisplay = group.items.length === 1 ? group.items[0] : group.label;
  const display = prose ? humanizeFindingText(rawDisplay) : rawDisplay;
  return (
    <div className="rounded-md border border-line-soft bg-bg-1/40">
      <div
        className={`flex items-start gap-2 px-2.5 py-1.5 ${
          drillable ? "cursor-pointer hover:bg-state-hover" : ""
        }`}
        onClick={drillable ? () => setOpen((v) => !v) : undefined}
      >
        {drillable ? (
          <span className="mt-0.5 text-text-4 flex-shrink-0">
            <FindingChevron expanded={open} />
          </span>
        ) : (
          <span className="w-2.5 flex-shrink-0" aria-hidden />
        )}
        <span className="flex-1 min-w-0 text-sm text-text-1 leading-snug break-words">
          {display}
        </span>
        <span className="flex-shrink-0 flex items-center gap-1.5 pt-0.5">
          <span className="text-2xs text-text-5" title={group.category}>
            {categoryLabel(group.category)}
          </span>
          {group.count > 1 && (
            <span className="text-2xs tabular-nums text-text-3 px-1.5 py-0.5 rounded-full bg-bg-2 border border-line-soft">
              ×{group.count}
            </span>
          )}
        </span>
      </div>
      {open && drillable && (
        <ul className="px-2.5 pb-2 pt-0.5 space-y-0.5 border-t border-line-soft/50">
          {group.items.slice(0, 50).map((it, i) => (
            <li
              key={i}
              className={
                prose
                  ? "text-xs text-text-3 leading-snug break-words pl-4"
                  : "text-xs text-text-3 font-mono leading-snug break-words pl-4"
              }
            >
              {prose ? humanizeFindingText(it) : it}
            </li>
          ))}
          {group.items.length > 50 && (
            <li className="text-xs text-text-5 pl-4">
              +{group.items.length - 50} more…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function FindingChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
    >
      <path
        d="M2 4l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}

function CleanCheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="text-accent-green flex-shrink-0"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.2 8.2l1.9 1.9 3.7-4"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Header pills ─────────────────────────────────────────────────────

function ReviewerPips({
  reviewers,
}: {
  reviewers: { login: string; state: string }[];
}) {
  // Show up to 4 reviewer avatars overlapped (Graphite-style cluster)
  // with a +N pill when there are more.
  const MAX = 4;
  const visible = reviewers.slice(0, MAX);
  const overflow = reviewers.length - visible.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((r) => (
        <Pip key={r.login} login={r.login} approved={r.state === "APPROVED"} />
      ))}
      {overflow > 0 && (
        <span className="relative w-6 h-6 rounded-full bg-bg-2 border border-bg-content text-text-3 text-2xs font-bold flex items-center justify-center">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function Pip({ login, approved }: { login: string; approved: boolean }) {
  const initial = (login || "?").charAt(0).toUpperCase();
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      title={`${login}${approved ? " ✓ approved" : ""}`}
      className="relative w-6 h-6 rounded-full border-2 border-bg-content flex items-center justify-center text-2xs font-bold text-white"
      style={{ backgroundColor: `hsl(${hue}, 45%, 38%)` }}
    >
      {initial}
      {approved && (
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-500 border border-bg-content text-white text-2xs font-bold flex items-center justify-center leading-none">
          ✓
        </span>
      )}
    </span>
  );
}

// Mirrors the populated 4-column layout (file tree + diff + right rail)
// so the cold-load silhouette matches the eventual content; user's eye
// stays put when data lands.
function PrDetailSkeleton() {
  return (
    <div className="flex-1 min-h-0 flex animate-pulse">
      <div className="w-[260px] flex-shrink-0 border-r border-line-soft p-3 space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-3 bg-bg-2 rounded w-full" />
        ))}
      </div>
      <div className="flex-1 min-w-0 border-r border-line-soft p-3 space-y-2">
        <div className="h-3 bg-bg-2 rounded w-1/3" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="h-3 bg-bg-2/60 rounded w-full" />
        ))}
      </div>
      <div className="w-[340px] flex-shrink-0 p-3 space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 bg-bg-2 rounded w-full" />
        ))}
      </div>
    </div>
  );
}

// FluidDiff bridges PrDiffBody's (rightLine, el) anchor callback to
// PrThreadProvider's register(key, el, thread) API, so threads for the
// active file render as floating popout cards in the right column
// (PrThreadColumn) instead of a flat list in a side rail. Mirrors the
// pattern PrFilesSection (PrOverviewTab) already uses.
function FluidDiff({
  repoRoot,
  prNumber,
  filePath,
  body,
  comments,
  onPosted,
}: {
  repoRoot: string;
  prNumber: number;
  filePath: string;
  body: string;
  comments: PrComment[];
  onPosted: () => void;
}) {
  const register = usePrThreadRegister();
  const threadByLine = useMemo(() => {
    const m = new Map<number, ReturnType<typeof groupThreads>[number]>();
    const own = comments.filter(
      (c) => !c.is_issue_comment && c.path === filePath,
    );
    for (const t of groupThreads(own)) {
      if (t.root.line != null) m.set(t.root.line, t);
    }
    return m;
  }, [comments, filePath]);
  const registerRow = useCallback(
    (rightLine: number, el: HTMLElement | null) => {
      if (!register) return;
      const key = `${filePath}@${rightLine}`;
      const t = threadByLine.get(rightLine) ?? null;
      register(key, el, t);
    },
    [register, threadByLine, filePath],
  );
  return (
    <PrDiffBody
      repoRoot={repoRoot}
      prNumber={prNumber}
      filePath={filePath}
      body={body}
      comments={comments}
      onPosted={onPosted}
      onRegisterRow={registerRow}
    />
  );
}

// ── Tab glyphs ───────────────────────────────────────────────────────
// 14px stroke icons for the header tab cells (WizardStepTabs `tabs`
// variant); colour is inherited (currentColor) so active = accent.

function OverviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2.5" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="8" width="7" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="8" width="3" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 2h5l3 3v9H4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4.5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H6l-3 2.5V10.5H4.5a2 2 0 01-2-2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChecksIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.5 8.2l1.7 1.7 3.3-3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderRiskChip(score: number, label: string) {
  const tone = score > 60 ? "red" : score > 0 ? "amber" : "green";
  return (
    <StatusChip dense tone={tone} title={`Aura risk score ${score}`}>
      aura {label || score}
    </StatusChip>
  );
}
