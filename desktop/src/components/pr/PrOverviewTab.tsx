// PrOverviewTab — Stage 8B. Graphite-style PR overview surface.
//
// Layout (matches the screenshot in the Stage 8B brief):
//   ┌───────────────────────────────────────────┬───────────────┐
//   │ Header (title, branch, files +/-, age)    │ Right Rail    │
//   │ Stack rail (3 of 4)                       │ - Status pill │
//   │ Description (markdown card)               │ - Ready merge │
//   │                                           │ - Checks      │
//   │                                           │ - Reviewers   │
//   │                                           │ - Labels      │
//   └───────────────────────────────────────────┴───────────────┘
//
// Sibling tabs (Files, Conversation) live in PRDetailPane. Overview
// owns no per-file rendering — diff browsing happens in Files.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type PrComment, type PrDetail, type PrLabel } from "../../lib/api";
import { fetchPrList } from "../../lib/prsCache";
import { PrStackRail } from "./PrStackRail";
import { PrDescriptionCard } from "./PrDescriptionCard";
import { PrDiscussionCard } from "./PrDiscussionCard";
import { PrRightRail, type ChecksSummary, type ThreadCounts } from "./PrRightRail";
import { LabelChip } from "./PrLabelsCard";
import { PrFilesSection } from "./PrFilesSection";
import { PrThreadColumn, PrThreadProvider } from "./PrThreadColumn";
import { PrFeatureRollup } from "./PrFeatureRollup";
import { Churn } from "../diff/Churn";

type Props = {
  repoRoot: string;
  prNumber: number;
  detail: PrDetail;
  checks: ChecksSummary | null;
  onMerge?: () => void;
};

export function PrOverviewTab({
  repoRoot,
  prNumber,
  detail,
  checks,
  onMerge,
}: Props) {
  const [viewer, setViewer] = useState<string>("");
  const [mergeWhenReady, setMergeWhenReady] = useState(false);
  const [labels, setLabels] = useState<PrLabel[]>([]);
  const [comments, setComments] = useState<PrComment[]>([]);

  const refreshComments = useCallback(async () => {
    try {
      const list = await api.prCommentsList(repoRoot, prNumber);
      setComments(list);
    } catch {
      // Network blip — keep prior list.
    }
  }, [repoRoot, prNumber]);

  useEffect(() => {
    void refreshComments();
  }, [refreshComments]);

  useEffect(() => {
    let cancelled = false;
    api.prWhoami(repoRoot).then((who) => {
      if (!cancelled) setViewer(who);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const refreshLabels = useCallback(async () => {
    try {
      const list = await fetchPrList(repoRoot);
      const me = list.find((p) => p.number === prNumber);
      if (me) setLabels(me.labels);
    } catch {
      // Network blip — keep existing labels rather than nuking them.
    }
  }, [repoRoot, prNumber]);

  useEffect(() => {
    void refreshLabels();
  }, [refreshLabels]);

  // Stack-merge readiness — best-effort. If the parent PR is approved
  // and downstack approved, "Merge N PRs" makes sense; otherwise show
  // single-PR merge. For v1 we just count Approved siblings via the
  // existing prList.
  const [stackReadyCount, setStackReadyCount] = useState(1);
  useEffect(() => {
    let cancelled = false;
    api
      .prStack(repoRoot, prNumber)
      .then(async (nodes) => {
        if (cancelled) return;
        const list = await fetchPrList(repoRoot).catch(() => []);
        const numbersInStack = new Set(nodes.map((n) => n.number));
        const approved = list.filter(
          (p) =>
            numbersInStack.has(p.number) &&
            p.review_decision === "APPROVED" &&
            !p.is_draft &&
            p.checks_state !== "failure",
        );
        if (!cancelled) setStackReadyCount(Math.max(approved.length, 1));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoRoot, prNumber]);

  // Derive thread counts from comments — root inline comments only,
  // not replies and not issue-level conversation comments.
  const threadCounts: ThreadCounts = useMemo(() => {
    const roots = comments.filter(
      (c) => !c.is_issue_comment && c.in_reply_to == null && c.line != null,
    );
    return {
      total: roots.length,
      unresolved: roots.filter((r) => !r.thread_resolved).length,
    };
  }, [comments]);

  const onViewUnresolved = useCallback((): string | null => {
    // Find the first unresolved root and scroll its anchor into view via
    // the data-thread-key marker emitted by PrFilesSection diff rows.
    // Returns the matched key so the caller (UnresolvedCommentsCard,
    // running inside PrThreadProvider) can also activate the highlight
    // — Stage 8L wires the comment ↔ code highlight via the same key.
    const root = comments.find(
      (c) =>
        !c.is_issue_comment &&
        c.in_reply_to == null &&
        c.line != null &&
        !c.thread_resolved,
    );
    if (!root || root.path == null || root.line == null) return null;
    const key = `${root.path}@${root.line}`;
    const node = document.querySelector(`[data-thread-key="${CSS.escape(key)}"]`);
    if (node && "scrollIntoView" in node) {
      (node as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return key;
  }, [comments]);

  // Stage 8I — single scroll container, two columns flow together. The
  // right rail is no longer a fixed sidebar: cards sit at the top of the
  // right column and scroll with the page (Graphite-style "fluid blocks").
  // Below the rail cards, the right strip is empty until the diff cards
  // beside it surface their floating threads.
  return (
    <PrThreadProvider
      repoRoot={repoRoot}
      prNumber={prNumber}
      onPosted={() => void refreshComments()}
    >
      <div className="h-full w-full overflow-y-auto bg-bg-content">
        <div
          className="mx-auto flex gap-4 px-4 pt-5 pb-10"
          style={{ maxWidth: 1320 }}
        >
          <main className="flex-1 min-w-0 space-y-4">
            <PrTitleHeader detail={detail} labels={labels} />
            <PrStackRail
              repoRoot={repoRoot}
              prNumber={prNumber}
              viewer={viewer}
            />
            <PrDescriptionCard body={detail.body ?? ""} />
            {/* The feature thread rolled up to this PR — is the thing this branch
                set out to build actually finished? Scoped to the PR's own commits;
                renders nothing until a proven goal is threaded to them. */}
            <PrFeatureRollup
              repoRoot={repoRoot}
              headRef={detail.head_ref}
              baseRef={detail.base_ref}
            />
            <PrDiscussionCard comments={comments} />
            <PrFilesSection
              repoRoot={repoRoot}
              prNumber={prNumber}
              baseRef={detail.base_ref}
              headRef={detail.head_ref}
              files={detail.files}
              diff={detail.diff ?? ""}
              diffError={detail.diff_error ?? null}
              comments={comments}
              onPosted={() => void refreshComments()}
              auraReview={detail.aura_review}
            />
          </main>
          <aside className="w-[320px] flex-shrink-0 relative">
            <PrRightRail
              noShell
              detail={detail}
              checks={checks}
              stackReadyCount={stackReadyCount}
              onMerge={onMerge}
              mergeWhenReady={mergeWhenReady}
              onToggleMergeWhenReady={() => setMergeWhenReady((v) => !v)}
              repoRoot={repoRoot}
              prNumber={prNumber}
              labels={labels}
              onLabelsChanged={refreshLabels}
              threadCounts={threadCounts}
              onViewUnresolved={onViewUnresolved}
            />
            <PrThreadColumn />
          </aside>
        </div>
      </div>
    </PrThreadProvider>
  );
}

function PrTitleHeader({
  detail,
  labels,
}: {
  detail: PrDetail;
  labels: PrLabel[];
}) {
  // GitHub URLs look like https://github.com/<owner>/<repo>/pull/<n>; we
  // surface "<repo> #<n>" above the title to match Graphite's header.
  const repoSlug = parseRepoSlug(detail.url);
  return (
    <header className="space-y-3">
      <div className="text-[11.5px] text-text-4 font-mono tracking-wide">
        {repoSlug ? `${repoSlug} ` : ""}#{detail.number}
      </div>
      <h1 className="text-[28px] font-semibold text-text-1 leading-[1.2] tracking-[-0.01em]">
        {detail.title}
      </h1>
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {labels.map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-3 pt-2">
        <div className="flex items-center gap-2">
          <Avatar name={detail.author} />
          <span className="text-text-2 font-medium">{detail.author}</span>
        </div>
        <span className="font-mono px-2 py-0.5 rounded bg-bg-2 text-text-2 text-[11px]">
          {detail.head_ref}
        </span>
        <span className="text-text-4">→</span>
        <span className="font-mono px-2 py-0.5 rounded bg-bg-2 text-text-2 text-[11px]">
          {detail.base_ref}
        </span>
        <span className="ml-auto flex items-center gap-3.5 tabular-nums text-text-4 text-[12px]">
          <span>
            {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
          </span>
          <Churn additions={detail.additions} deletions={detail.deletions} />
          <span>Updated {formatAge(detail.updated_at)} ago</span>
        </span>
      </div>
    </header>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <span className="w-6 h-6 rounded-full bg-violet/30 text-violet flex items-center justify-center text-[11px] font-bold">
      {initial}
    </span>
  );
}

function parseRepoSlug(url: string): string | null {
  // Returns "<repo>" from https://github.com/<owner>/<repo>/pull/<n>;
  // falls back to null when the URL doesn't match.
  if (!url) return null;
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\//);
  return m ? m[1] : null;
}

function formatAge(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}
