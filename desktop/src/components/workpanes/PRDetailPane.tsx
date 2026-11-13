// The pull request page: Overview (the shared pull request view), Files (the
// file list, each file's meaning and patch, threads, stack and safety-check
// findings) and Checks, under one header with the review footer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { SquareArrowOutUpRight } from "lucide-react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { type PrComment, type PrDetail } from "../../lib/api";
import { fetchPrList } from "../../lib/prsCache";
import { findingsByPath } from "../../lib/prReviewState";
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
import { useEditorStore, type PrDetailTab } from "../../lib/editorStore";
import { useGitChats } from "../../lib/gitChat";
import { updatePrJobId } from "../../lib/worktreeActions";
import { PrApprovalBar } from "../pr/PrApprovalBar";
import { PrOverview } from "../pr/overview/PrOverview";
import { PrChecksTab } from "../pr/PrChecksTab";
import { PrFilesTab, type PrFilesAsideTab } from "../pr/files/PrFilesTab";
import { usePrChangeStory } from "../pr/files/usePrChangeStory";
import {
  ChecksIcon,
  FilesIcon,
  OverviewIcon,
  PrDetailSkeleton,
  ReviewerPips,
  UpdateWithAuraButton,
  hashRoot,
  renderRiskChip,
} from "../pr/detail/PrDetailParts";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs, type WizardStepMeta } from "../ui/wizard";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/statusChip";
import { GhErrorNotice } from "../github/GhErrorNotice";
import { requestPrAuthoring } from "../dialogs/PrAuthoringDialog";

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

type TopTab = PrDetailTab;

// Main header tabs — driven through the shared WizardStepTabs (variant="tabs")
// so the PR detail header reads identically to the create-task wizard. The
// strip is non-sequential (every tab always jumpable); we map the string TopTab
// keys to the numeric index WizardStepTabs expects via TOP_TAB_IDS.
const TOP_TABS: WizardStepMeta[] = [
  { id: "overview", label: "Overview", icon: <OverviewIcon /> },
  { id: "files", label: "Files", icon: <FilesIcon /> },
  { id: "checks", label: "Checks", icon: <ChecksIcon /> },
];
const TOP_TAB_IDS = TOP_TABS.map((t) => t.id) as TopTab[];

export function PRDetailPane({ onClose, selOverride, embedded = false, onDetach }: Props) {
  const editor = useEditorStore();
  // A detached popout window seeds its PR via `selOverride`; the in-app
  // singleton tracks the editor store's current selection.
  const sel = selOverride ?? editor.selectedPr;
  // Chats being started for this repo. The PR you are READING is the one this
  // pane can update with Aura, and `updatePrJobId` scopes the send to that PR —
  // so the review rail's Update button lights up with this one when they mean
  // the same pull request, and ignores it when they don't.
  const chat = useGitChats(sel?.repoRoot ?? "");
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
  const [rightTab, setRightTab] = useState<PrFilesAsideTab>("threads");
  const [topTab, setTopTab] = useState<TopTab>("overview");
  const [, setLastSeenAt] = useState<string | null>(null);
  // Per-file "Viewed" state for the Files tab, keyed identically
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
  // the Overview, where the discussion is. A cold mount consumes the stashed value; an already-open tab
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

  // Comments render on the Overview (its activity) and the Files tab (inline
  // threads) — fetch them when one of those is open, not for Checks. Warm-cache
  // comments still paint instantly via the reset effect above.
  const commentsNeeded = topTab === "overview" || topTab === "files";
  useEffect(() => {
    if (commentsNeeded) void refreshComments();
  }, [commentsNeeded, refreshComments]);

  // Per file, how many safety-check findings name it — the Files tree marks
  // each so a clean-looking row is a clean file.
  const findingCounts = useMemo(
    () => findingsByPath(data?.aura_review, (data?.files ?? []).map((f) => f.path)),
    [data],
  );

  // Hydrate the Viewed set from localStorage whenever the file
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
  // call order, not name, so a hook below the `if (!sel) return …` guard
  // would change the count when sel toggles.

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

  if (!sel) {
    return (
      <FullscreenOverlay onClose={onClose} embedded={embedded}>
        <div className="flex-1 flex items-center justify-center text-text-4 text-sm">
          No PR selected.
        </div>
      </FullscreenOverlay>
    );
  }

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
          {/* The Overview's details list says all three; the other tabs keep
              them in sight. */}
          {topTab !== "overview" && checksChip}
          {topTab !== "overview" && riskChip}
          {topTab !== "overview" && data?.reviewers && data.reviewers.length > 0 && (
            <ReviewerPips reviewers={data.reviewers} />
          )}
          {refreshing && (
            <AsciiSpinner className="text-sm" />
          )}
          {onDetach && (
            <Button
              variant="ghost"
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
                chat(updatePrJobId(sel.number))
              }
            />
          )}
          {data && sel && data.state === "OPEN" && (
            <Button
              variant="ghost"
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
            variant="ghost"
            size="xs"
            onClick={refreshAll}
            title="Refresh from gh"
          >
            Refresh
          </Button>
          {data?.url && (
            <Button variant="ghost" size="xs" asChild title="Open on GitHub">
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
                variant="ghost"
                size="sm"
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
              baseRef={data.base_ref}
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
        <div className="flex-1 min-h-0 flex flex-col">
          <PrOverview
            repoRoot={sel.repoRoot}
            detail={data}
            comments={comments}
            checks={checks}
            onOpenTab={setTopTab}
            onOpenFindings={() => {
              setRightTab("findings");
              setTopTab("files");
            }}
            onClose={onClose}
            onMutated={refreshAll}
            onCommentsChanged={() => void refreshComments(true)}
          />
        </div>
      ) : topTab === "checks" ? (
        <PrChecksTab repoRoot={sel.repoRoot} prNumber={sel.number} />
      ) : (
        <PrFilesTab
          repoRoot={sel.repoRoot}
          prNumber={sel.number}
          detail={data}
          comments={comments}
          changeStory={changeStory}
          activePath={activePath}
          onSelectPath={setActivePath}
          viewedPaths={viewedPaths}
          onToggleViewed={toggleViewed}
          findingCounts={findingCounts}
          asideTab={rightTab}
          onAsideTab={setRightTab}
          onCommentsChanged={() => void refreshComments(true)}
        />
      )}
    </FullscreenOverlay>
  );
}
