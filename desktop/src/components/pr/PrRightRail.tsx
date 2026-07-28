// PrRightRail — Stage 8B. Graphite-style PR right column.
//
// Five stacked cards, each ~rounded-lg with subtle border:
//   1. Status pill — Open / Draft / Merged / Closed + Merge-when-ready toggle
//   2. Ready-to-merge — green card with action button (only when ready)
//   3. Checks       — N count + "View all" + per-check rows w colored icon
//   4. Reviewers    — collapsible w avatars + ✓/× decision
//   5. Labels       — colored chips + `+` opens picker
//
// Data is fed in as props rather than fetched here so PRDetailPane can
// reuse the existing detail/checks fetches and stay the single source
// of truth.

import { useEffect, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { humanizeFindingText } from "../../lib/humanizeFinding";
import {
  api,
  type AuraReviewPayload,
  type PrDetail,
  type PrLabel,
  type PrRelatedIssue,
  type PrReviewer,
} from "../../lib/api";
import { PrLabelsCard } from "./PrLabelsCard";
import { usePrThreadActive } from "./PrThreadColumn";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  StatusChip,
  type ChipTone,
  PR_STATE_CHIP,
} from "../ui/statusChip";

export type ThreadCounts = {
  total: number;
  unresolved: number;
};

type Props = {
  detail: PrDetail;
  checks: ChecksSummary | null;
  stackReadyCount: number;
  onMerge?: () => void;
  onToggleMergeWhenReady?: () => void;
  mergeWhenReady?: boolean;
  /** Repo root + PR number forwarded to the labels card so it can
   *  edit labels without re-deriving them from `detail`. */
  repoRoot: string;
  prNumber: number;
  /** Labels carried on PrSummary (Stage 8D). PrDetail doesn't include
   *  labels yet, so the parent reads them from the matching PrSummary
   *  in prList. */
  labels: PrLabel[];
  onLabelsChanged?: () => void;
  /** Stage 8I — when true, render the cards as inline blocks without
   *  the fixed-width sidebar shell (no border-l, no separate scroll,
   *  no bg). The parent supplies the column wrapper so the rail flows
   *  with the page (fluid), Graphite-style. */
  noShell?: boolean;
  /** Stage 8J — thread totals so the right rail can render the
   *  Graphite-style "Unresolved comments" callout. Optional; absent =
   *  card hidden. */
  threadCounts?: ThreadCounts | null;
  /** Click "View comments" — parent scrolls the page to the first
   *  unresolved thread anchor. */
  /** Stage 8L — returns the activated thread anchor key (or null) so
   *  UnresolvedCommentsCard can both scroll AND highlight via the
   *  PrThreadProvider context. */
  onViewUnresolved?: () => string | null | void;
};

export type ChecksSummary = {
  state: string | null;
  passing: number;
  failing: number;
  pending: number;
  total: number;
  /** Optional per-check rows; backend can populate later. For now we
   *  surface the aggregate state and synthesize generic rows from the
   *  passing/failing/pending counts. */
  rows?: Array<{ name: string; state: "success" | "failure" | "pending"; summary?: string }>;
};

export function PrRightRail({
  detail,
  checks,
  stackReadyCount,
  onMerge,
  onToggleMergeWhenReady,
  mergeWhenReady = false,
  repoRoot,
  prNumber,
  labels,
  onLabelsChanged,
  noShell = false,
  threadCounts = null,
  onViewUnresolved,
}: Props) {
  const cards = (
    <div className="space-y-3">
      <StatusCard
        state={detail.state}
        isDraft={detail.is_draft}
        mergeWhenReady={mergeWhenReady}
        onToggleMergeWhenReady={onToggleMergeWhenReady}
      />
      {detail.state === "MERGED" && (
        <MergedCeremonyCard
          mergedBy={detail.merged_by}
          mergedAt={detail.merged_at}
          url={detail.url}
        />
      )}
      {threadCounts && threadCounts.unresolved > 0 && (
        <UnresolvedCommentsCard
          count={threadCounts.unresolved}
          onView={onViewUnresolved}
        />
      )}
      {detail.review_decision === "APPROVED" && detail.state === "OPEN" && (
        <ReadyToMergeCard count={stackReadyCount} onMerge={onMerge} />
      )}
      <ChecksCard checks={checks} />
      <AuraReviewCard
        review={detail.aura_review}
        repoRoot={repoRoot}
        prNumber={prNumber}
        baseRef={detail.base_ref}
      />
      <ReviewersCard reviewers={detail.reviewers} />
      <PrLabelsCard
        repoRoot={repoRoot}
        prNumber={prNumber}
        initial={labels}
        onChanged={onLabelsChanged}
      />
      <AssigneesCard assignees={detail.assignees} />
      <RelatedTasksCard issues={detail.related_issues} />
    </div>
  );

  if (noShell) return cards;
  return (
    <div className="w-[320px] flex-shrink-0 border-l border-line-soft bg-bg-1/40 overflow-y-auto">
      <div className="p-3">{cards}</div>
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────

function StatusCard({
  state,
  isDraft,
  mergeWhenReady,
  onToggleMergeWhenReady,
}: {
  state: string;
  isDraft: boolean;
  mergeWhenReady: boolean;
  onToggleMergeWhenReady?: () => void;
}) {
  const isMerged = state === "MERGED";
  const isClosed = state === "CLOSED";
  const stateKey: keyof typeof PR_STATE_CHIP = isDraft
    ? "draft"
    : isMerged
      ? "merged"
      : isClosed
        ? "closed"
        : "open";
  const spec = PR_STATE_CHIP[stateKey];
  const label = isDraft ? "Draft" : capitalize(state.toLowerCase());
  return (
    <div className="rounded-lg border border-line-soft bg-bg-content overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 h-11">
        <StatusChip tone={spec.tone} dot icon={<PrIcon />}>
          {label}
        </StatusChip>
        {!isMerged && !isClosed && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11.5px] text-text-3">Merge when ready</span>
            <Toggle on={mergeWhenReady} onChange={() => onToggleMergeWhenReady?.()} />
          </div>
        )}
      </div>
    </div>
  );
}

function UnresolvedCommentsCard({
  count,
  onView,
}: {
  count: number;
  onView?: () => string | null | void;
}) {
  const { setActiveKey } = usePrThreadActive();
  const noun = count === 1 ? "comment thread" : "comment threads";
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="text-[13px] leading-none font-semibold mt-0.5"
          style={{ color: AMBER }}
        >
          !
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-1">
            Unresolved comments
          </div>
          <div className="text-[11px] text-text-3 mt-0.5 leading-snug">
            {count} {noun} {count === 1 ? "needs" : "need"} resolving before this
            PR can merge.
          </div>
        </div>
      </div>
      <Button
        variant="subtle"
        size="lg"
        onClick={() => {
          const key = onView?.();
          if (typeof key === "string") setActiveKey(key);
        }}
        className="mt-3 w-full"
      >
        View comments
      </Button>
    </div>
  );
}

// The "in progress / needs a look" hue. Goes through the token so the tokens
// layer stays the single source of truth — the same one PrChecksTab paints
// pending checks with, so a check reads identically in the rail and the tab.
const AMBER = "var(--color-amber)";

function MergedCeremonyCard({
  mergedBy,
  mergedAt,
  url,
}: {
  mergedBy: string | null;
  mergedAt: string | null;
  url: string;
}) {
  const when = mergedAt ? formatMergeTime(mergedAt) : null;
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="text-[13px] leading-none font-semibold mt-0.5"
          style={{ color: "var(--color-violet)" }}
        >
          ✓
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-1">
            Merged
          </div>
          <div className="text-[11px] text-text-3 mt-0.5 leading-snug">
            {mergedBy
              ? `Merged by ${mergedBy}${when ? ` on ${when}` : ""}.`
              : when
                ? `Merged on ${when}.`
                : "This pull request was merged."}
          </div>
        </div>
      </div>
      {url && (
        <Button variant="subtle" size="lg" asChild className="mt-3 w-full">
          <a href={url} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>
            Open on GitHub
          </a>
        </Button>
      )}
    </div>
  );
}

function formatMergeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}

function AssigneesCard({ assignees }: { assignees: string[] }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card
      title="Assignees"
      collapsible
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      right={
        <Button
          variant="ghost"
          size="icon-sm"
          className="w-5 h-5 text-text-4 hover:text-text-1 text-[12px]"
          title="Add assignee"
        >
          +
        </Button>
      }
    >
      {expanded && (
        assignees.length === 0 ? (
          <div className="text-[11.5px] text-text-4">
            No assignees ·{" "}
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0 text-[11.5px] text-text-3 hover:text-text-1"
            >
              Assign yourself
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5">
            {assignees.map((login) => (
              <AssigneeRow key={login} login={login} />
            ))}
          </div>
        )
      )}
    </Card>
  );
}

function AssigneeRow({ login }: { login: string }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <ReviewerAvatar name={login} />
      <span className="flex-1 min-w-0 truncate text-[12px] text-text-2">{login}</span>
    </div>
  );
}

function RelatedTasksCard({ issues }: { issues: PrRelatedIssue[] }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card
      title="Related tasks"
      count={issues.length || undefined}
      collapsible
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      right={
        <Button
          variant="ghost"
          size="icon-sm"
          className="w-5 h-5 text-text-4 hover:text-text-1 text-[12px]"
          title="Link a task"
        >
          +
        </Button>
      }
    >
      {expanded && (
        issues.length === 0 ? (
          <div className="text-[11.5px] text-text-4">No related tasks</div>
        ) : (
          <div className="space-y-1.5">
            {issues.map((i) => (
              <RelatedTaskRow key={i.url || i.number} issue={i} />
            ))}
          </div>
        )
      )}
    </Card>
  );
}

function RelatedTaskRow({ issue }: { issue: PrRelatedIssue }) {
  const closed = issue.state === "CLOSED";
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      onClick={onExternalAnchorClick}
      className="flex items-center gap-2 py-0.5 group"
    >
      <span
        className="w-4 h-4 rounded-sm flex items-center justify-center flex-shrink-0 text-[10px] font-bold"
        style={{
          background: `color-mix(in srgb, ${
            closed ? "var(--color-violet)" : "var(--color-accent-green)"
          } 20%, transparent)`,
          color: closed ? "var(--color-violet)" : "var(--color-accent-green)",
        }}
      >
        {closed ? "✓" : "○"}
      </span>
      <span className="text-[11.5px] font-mono text-text-4 flex-shrink-0">
        #{issue.number}
      </span>
      <span className="text-[12px] text-text-2 truncate group-hover:text-text-1 transition-colors">
        {issue.title}
      </span>
    </a>
  );
}

function ReadyToMergeCard({
  count,
  onMerge,
}: {
  count: number;
  onMerge?: () => void;
}) {
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="text-[14px] mt-0.5"
          style={{ color: "var(--color-accent-green)" }}
        >
          ✓
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-1">
            {count > 1 ? "Ready to merge as stack" : "Ready to merge"}
          </div>
          <div className="text-[11px] text-text-3 mt-0.5 leading-snug">
            {count > 1
              ? "This PR and all the PRs stacked below it can be merged."
              : "All checks pass and reviewers have approved."}
          </div>
        </div>
      </div>
      <Button
        variant="accentSoft"
        size="lg"
        onClick={onMerge}
        className="mt-3 w-full"
      >
        Merge {count > 1 ? `${count} PRs` : "PR"}
      </Button>
    </div>
  );
}

function ChecksCard({ checks }: { checks: ChecksSummary | null }) {
  const [expanded, setExpanded] = useState(true);
  if (!checks || checks.total === 0) {
    return (
      <Card
        title="Checks"
        collapsible
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        right={<span className="text-[11px] text-text-4">—</span>}
      >
        {expanded && (
          <div className="flex items-center gap-2 text-[11.5px] text-text-4">
            <span className="w-4 h-4 rounded-full border border-line-soft flex items-center justify-center text-[8px] text-text-4">
              ⏿
            </span>
            <span>No automated checks set up</span>
          </div>
        )}
      </Card>
    );
  }
  const total = Math.max(checks.total, 1);
  const passPct = (checks.passing / total) * 100;
  const failPct = (checks.failing / total) * 100;
  const pendPct = (checks.pending / total) * 100;
  // Synthesize rows when backend doesn't provide named ones — three
  // grouped pseudo-rows by state. Replaced by real per-check rows once
  // pr_checks_list lands.
  const rows: ChecksSummary["rows"] = checks.rows ?? synthRows(checks);
  return (
    <Card
      title="Checks"
      count={checks.total}
      right={
        <Button variant="subtle" size="xs" className="gap-1">
          <RefreshIcon />
          View all
        </Button>
      }
      collapsible
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {/* progress bar */}
      <div className="flex h-1 rounded-full overflow-hidden bg-bg-2 mb-3">
        {passPct > 0 && (
          <div
            style={{
              width: `${passPct}%`,
              background: "var(--color-accent-green)",
            }}
          />
        )}
        {failPct > 0 && (
          <div
            style={{ width: `${failPct}%`, background: "var(--color-red)" }}
          />
        )}
        {pendPct > 0 && (
          <div style={{ width: `${pendPct}%`, background: AMBER }} />
        )}
      </div>
      {expanded && (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <CheckRow key={r.name} {...r} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CheckRow({
  name,
  state,
  summary,
}: {
  name: string;
  state: "success" | "failure" | "pending";
  summary?: string;
}) {
  const glyphColor =
    state === "success"
      ? "var(--color-accent-green)"
      : state === "failure"
        ? "var(--color-red)"
        : AMBER;
  const icon = (
    <span
      className="w-3.5 h-3.5 rounded-sm text-[10px] flex items-center justify-center font-bold"
      style={{
        background: `color-mix(in srgb, ${glyphColor} 20%, transparent)`,
        color: glyphColor,
      }}
    >
      {state === "success" ? "✓" : state === "failure" ? "✕" : "…"}
    </span>
  );
  return (
    <div className="flex items-start gap-2">
      <GhActionIcon />
      <div className="flex-1 min-w-0">
        <div className="text-[11.5px] text-text-1 truncate font-mono">{name}</div>
        {summary && (
          <div className="text-[10.5px] text-text-4 truncate">{summary}</div>
        )}
      </div>
      {icon}
    </div>
  );
}

function ReviewersCard({ reviewers }: { reviewers: PrReviewer[] }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card
      title="Reviewers"
      count={reviewers.length}
      collapsible
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      right={
        <Button
          variant="ghost"
          size="icon-sm"
          className="w-5 h-5 text-text-4 hover:text-text-1 text-[12px]"
          title="Add reviewer"
        >
          +
        </Button>
      }
    >
      {expanded && (
        reviewers.length === 0 ? (
          <div className="flex items-center gap-2 text-[11.5px] text-text-4">
            <span className="w-4 h-4 rounded-full border border-line-soft" />
            <span>No reviewers requested</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {reviewers.map((r) => (
              <ReviewerRow key={r.login} reviewer={r} />
            ))}
          </div>
        )
      )}
    </Card>
  );
}

function ReviewerRow({ reviewer }: { reviewer: PrReviewer }) {
  const tone =
    reviewer.state === "APPROVED"
      ? "text-text-2"
      : reviewer.state === "CHANGES_REQUESTED"
        ? "text-text-2"
        : reviewer.state === "PENDING"
          ? "text-text-3"
          : "text-text-2";
  const statusIcon =
    reviewer.state === "APPROVED" ? (
      <span
        className="text-[12px] leading-none"
        style={{ color: "var(--color-accent-green)" }}
      >
        ✓
      </span>
    ) : reviewer.state === "CHANGES_REQUESTED" ? (
      <span
        className="text-[12px] leading-none"
        style={{ color: "var(--color-red)" }}
      >
        ✕
      </span>
    ) : reviewer.state === "COMMENTED" ? (
      <span className="text-text-3 text-[11px] leading-none">💬</span>
    ) : null;
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <ReviewerAvatar name={reviewer.login} />
      <span className={`flex-1 min-w-0 truncate text-[12px] ${tone}`}>
        {reviewer.login}
      </span>
      {statusIcon}
    </div>
  );
}

function ReviewerAvatar({ name }: { name: string }) {
  const initial = (name || "?").charAt(0).toUpperCase();
  // Hue-rotated by login so two reviewers don't look identical.
  const hue = hashHue(name);
  return (
    <span
      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 text-white"
      style={{
        backgroundColor: `hsl(${hue}, 45%, 38%)`,
      }}
      title={name}
    >
      {initial}
    </span>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ── Aura Review ────────────────────────────────────────────────────

function AuraReviewCard({
  review,
  repoRoot,
  prNumber,
  baseRef,
}: {
  review: AuraReviewPayload | null;
  repoRoot: string;
  prNumber: number;
  baseRef: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successFlash, setSuccessFlash] = useState<string | null>(null);
  const [section, setSection] = useState<
    "violations" | "blast" | "unverified" | "conflicts" | null
  >(null);

  // Tick the elapsed-time counter once a second while the review runs so
  // the user has visible proof the job is still working — the CLI can
  // easily take 30–90s on a big PR, long enough that a static "Running…"
  // looks frozen.
  useEffect(() => {
    if (!running || runStartedAt == null) return;
    setRunElapsed(0);
    const id = window.setInterval(() => {
      setRunElapsed(Math.floor((Date.now() - runStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, runStartedAt]);

  const runReview = async () => {
    setRunning(true);
    setError(null);
    setSuccessFlash(null);
    setRunStartedAt(Date.now());
    try {
      const result = await api.auraCli(repoRoot, [
        "pr-review",
        "--base",
        baseRef || "main",
      ]);
      if (result.status !== 0) {
        setError(result.stderr.trim() || `aura pr-review exited ${result.status}`);
        return;
      }
      // The CLI wrote `.aura/pr-reviews/<N>.json`. Force a cache refresh
      // so the parent PR pane picks up the new payload without the user
      // needing to navigate away and back.
      try {
        const refreshed = await invalidatePrDetail(repoRoot, prNumber);
        const r = refreshed.aura_review;
        const violations = r?.invariant_violations?.length ?? 0;
        const unverified = countUnverified(r?.unverified_nodes ?? null);
        const parts: string[] = [];
        if (violations > 0)
          parts.push(`${violations} broken rule${violations === 1 ? "" : "s"}`);
        if (unverified > 0) parts.push(`${unverified} unproven`);
        const summary = parts.length
          ? `Safety check done · ${parts.join(" · ")}`
          : "Safety check done · all clear";
        setSuccessFlash(summary);
        // OS toast so the user sees confirmation even if the PR pane is
        // out of view.
        try {
          window.dispatchEvent(
            new CustomEvent("aura:toast", {
              detail: { kind: "success", text: summary, ttlMs: 6000 },
            }),
          );
        } catch {
          /* dispatch is best-effort */
        }
        // Auto-dismiss the inline flash after a few seconds.
        window.setTimeout(() => setSuccessFlash(null), 6000);
      } catch (e) {
        // Refresh failure is non-fatal — surface as a soft warning so
        // the user can manually re-open the PR if needed.
        setError(
          `Review ran, but refresh failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setRunStartedAt(null);
    }
  };

  if (!review) {
    return (
      <Card
        title="Safety check"
        right={<SparkleIcon />}
        collapsible
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        {expanded && (
          <div className="space-y-2">
            <div className="text-[11.5px] text-text-4 leading-snug">
              A second set of eyes on this change — Aura compares it against{" "}
              <span className="font-mono text-text-3">{baseRef || "the base"}</span>{" "}
              for broken rules, what else it touches, and anything left unproven.
            </div>
            <Button
              variant="subtle"
              size="default"
              onClick={runReview}
              disabled={running}
              className="w-full"
            >
              {running ? (
                <>
                  <AsciiSpinner className="text-[11px]" />
                  <span className="tabular-nums">Running… {runElapsed}s</span>
                </>
              ) : (
                "Run safety check"
              )}
            </Button>
            {successFlash && (
              <div className="text-[11px] rounded border border-line-soft bg-bg-1 px-2 py-1.5 flex items-center gap-1.5 text-text-2">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                  style={{ color: "var(--color-accent-green)" }}
                >
                  <path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{successFlash}</span>
              </div>
            )}
            {error && (
              <details
                open
                className="text-[10.5px] rounded border border-line-soft bg-bg-1 px-2 py-1.5"
              >
                <summary className="text-red font-medium cursor-pointer select-none">
                  Review failed
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words text-red/90 font-mono text-[10px] leading-snug max-h-32 overflow-y-auto">
                  {error.length > 800 ? error.slice(0, 800) + "\n…" : error}
                </pre>
              </details>
            )}
          </div>
        )}
      </Card>
    );
  }

  const tone = riskTone(review.risk_score);
  const unverifiedCount = countUnverified(review.unverified_nodes);

  return (
    <Card
      title="Safety check"
      right={
        <Button
          variant="subtle"
          size="xs"
          onClick={runReview}
          disabled={running}
          className="gap-1"
          title="Re-run the safety check"
        >
          {running ? (
            <>
              <AsciiSpinner className="text-[10px]" />
              <span className="tabular-nums">{runElapsed}s</span>
            </>
          ) : (
            <>
              <RefreshIcon />
              Re-run
            </>
          )}
        </Button>
      }
      collapsible
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {expanded && (
        <div className="space-y-2.5">
          {successFlash && (
            <div className="text-[11px] rounded border border-accent-green/40 bg-accent-green/10 text-accent-green px-2 py-1.5 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{successFlash}</span>
            </div>
          )}
          {error && (
            <details
              open
              className="text-[10.5px] rounded border border-red/40 bg-red/10 px-2 py-1.5"
            >
              <summary className="text-red font-medium cursor-pointer select-none">
                Safety-check error
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-red/90 font-mono text-[10px] leading-snug max-h-32 overflow-y-auto">
                {error.length > 800 ? error.slice(0, 800) + "\n…" : error}
              </pre>
            </details>
          )}
          {/* Risk pill */}
          <div className="flex items-center gap-2">
            <StatusChip tone={tone} icon={<SparkleIcon />}>
              {review.risk_label || riskLabel(review.risk_score)}
            </StatusChip>
            <span
              className="text-[11px] text-text-4 tabular-nums"
              title="How risky this change looks, scored 0–100 (higher = riskier)"
            >
              risk {review.risk_score}/100
            </span>
            <span className="ml-auto text-[10.5px] text-text-4">
              {review.total_changes} change{review.total_changes === 1 ? "" : "s"}
            </span>
          </div>

          {/* Counters grid */}
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <Counter
              label="Broken rules"
              count={review.invariant_violations.length}
              tone="red"
              active={section === "violations"}
              onClick={() =>
                setSection(section === "violations" ? null : "violations")
              }
            />
            <Counter
              label="Ripple effects"
              count={review.blast_radius.length}
              tone="amber"
              active={section === "blast"}
              onClick={() => setSection(section === "blast" ? null : "blast")}
            />
            <Counter
              label="Unproven"
              count={unverifiedCount}
              tone="violet"
              active={section === "unverified"}
              onClick={() =>
                setSection(section === "unverified" ? null : "unverified")
              }
            />
            <Counter
              label="Branch clashes"
              count={review.cross_branch_conflicts.length}
              tone="sky"
              active={section === "conflicts"}
              onClick={() =>
                setSection(section === "conflicts" ? null : "conflicts")
              }
            />
          </div>

          {section && (
            <div className="rounded-md border border-line-soft bg-bg-1/40 max-h-44 overflow-y-auto">
              <FindingList review={review} section={section} />
            </div>
          )}

          {error && (
            <details
              open
              className="text-[10.5px] rounded border border-red/40 bg-red/10 px-2 py-1.5"
            >
              <summary className="text-red font-medium cursor-pointer select-none">
                Re-run failed
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-red/90 font-mono text-[10px] leading-snug max-h-32 overflow-y-auto">
                {error.length > 800 ? error.slice(0, 800) + "\n…" : error}
              </pre>
            </details>
          )}

          <div className="text-[10.5px] text-text-4">
            Updated {relAge(review.ts)} · base{" "}
            <span className="font-mono text-text-3">{review.base_branch}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Counter({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: "red" | "amber" | "violet" | "sky";
  active: boolean;
  onClick: () => void;
}) {
  const toneColor =
    tone === "red"
      ? "var(--color-red)"
      : tone === "amber"
        ? AMBER
        : tone === "violet"
          ? "var(--color-violet)"
          : "var(--color-blue)";
  const dim = count === 0 ? "opacity-50" : "";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      style={{
        color: toneColor,
        borderColor: `color-mix(in srgb, ${toneColor} 30%, transparent)`,
        background: `color-mix(in srgb, ${toneColor} 10%, transparent)`,
      }}
      className={`flex items-center justify-between gap-1 px-2 h-7 rounded-md border ${dim} ${
        active ? "ring-1 ring-inset ring-white/30" : ""
      } disabled:cursor-default hover:brightness-110 transition`}
    >
      <span className="truncate">{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
    </button>
  );
}

function FindingList({
  review,
  section,
}: {
  review: AuraReviewPayload;
  section: "violations" | "blast" | "unverified" | "conflicts";
}) {
  const items: string[] =
    section === "violations"
      ? review.invariant_violations
      : section === "blast"
        ? review.blast_radius
        : section === "conflicts"
          ? review.cross_branch_conflicts
          : flattenUnverified(review.unverified_nodes);
  if (items.length === 0) {
    return (
      <div className="px-2 py-2 text-[11px] text-text-4 italic">Nothing here.</div>
    );
  }
  // Rule-breaks and clashes arrive as raw engine strings ("Protected Node
  // Deleted: …") — read them as plain prose. Ripple effects and unproven
  // items are bare code identifiers, so they stay in a mono font.
  const isProse = section === "violations" || section === "conflicts";
  return (
    <ul className="divide-y divide-line-soft/40">
      {items.map((it, i) => (
        <li
          key={i}
          className={
            isProse
              ? "px-2 py-1.5 text-[11px] text-text-2 break-words leading-snug"
              : "px-2 py-1.5 text-[11px] text-text-2 font-mono break-words leading-snug"
          }
        >
          {isProse ? humanizeFindingText(it) : it}
        </li>
      ))}
    </ul>
  );
}

function riskTone(score: number): ChipTone {
  if (score >= 70) return "red";
  if (score >= 40) return "amber";
  return "green";
}

function riskLabel(score: number): string {
  if (score >= 70) return "High risk";
  if (score >= 40) return "Medium";
  return "Low risk";
}

function countUnverified(uv: unknown): number {
  if (Array.isArray(uv)) return uv.length;
  return 0;
}

function flattenUnverified(uv: unknown): string[] {
  if (!Array.isArray(uv)) return [];
  return uv.map((n) => {
    if (typeof n === "string") return n;
    if (n && typeof n === "object") {
      const obj = n as Record<string, unknown>;
      const path = typeof obj.path === "string" ? obj.path : null;
      const node = typeof obj.node === "string" ? obj.node : null;
      if (path && node) return `${path} :: ${node}`;
      if (path) return path;
      if (node) return node;
      return JSON.stringify(obj);
    }
    return String(n);
  });
}

function relAge(ts: number): string {
  if (!ts) return "—";
  // Backend ts may be unix seconds or millis; normalise.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

function SparkleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
    </svg>
  );
}

// ── Atoms ──────────────────────────────────────────────────────────

function Card({
  title,
  count,
  right,
  collapsible,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  right?: React.ReactNode;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line-soft bg-bg-content overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 h-10 border-b border-line-soft/50">
        {collapsible && (
          <button
            type="button"
            onClick={onToggle}
            className="text-text-4 hover:text-text-1 flex items-center"
            title={expanded ? "Collapse" : "Expand"}
          >
            <svg
              width="11"
              height="11"
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
          </button>
        )}
        <span className="text-[12.5px] font-semibold text-text-1">{title}</span>
        {typeof count === "number" && (
          <span className="text-[11.5px] text-text-4 tabular-nums">{count}</span>
        )}
        <div className="ml-auto">{right}</div>
      </div>
      {(!collapsible || expanded) && (
        <div className="px-3.5 py-3">{children}</div>
      )}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={on}
      className="relative w-7 h-4 rounded-full transition-colors"
      style={{ background: on ? "var(--color-violet)" : "var(--color-bg-3)" }}
    >
      <span
        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
          on ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// ── Icons ──────────────────────────────────────────────────────────

function PrIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="3" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5v6M12 11V8a3 3 0 00-3-3H6.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function GhActionIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="text-text-4 mt-0.5">
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function synthRows(c: ChecksSummary): NonNullable<ChecksSummary["rows"]> {
  const rows: NonNullable<ChecksSummary["rows"]> = [];
  if (c.failing > 0) {
    rows.push({
      name: `${c.failing} check${c.failing === 1 ? "" : "s"} failing`,
      state: "failure",
      summary: "Open “View all” on GitHub to see the logs.",
    });
  }
  if (c.pending > 0) {
    rows.push({
      name: `${c.pending} check${c.pending === 1 ? "" : "s"} pending`,
      state: "pending",
    });
  }
  if (c.passing > 0) {
    rows.push({
      name: `${c.passing} check${c.passing === 1 ? "" : "s"} passing`,
      state: "success",
    });
  }
  return rows;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
