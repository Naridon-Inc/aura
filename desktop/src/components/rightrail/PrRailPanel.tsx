// PrRailPanel — the PR triage Inbox, re-homed into the right rail (ADE).
//
// IA decision (docs/plan/22 §H): pull requests live in ONE place. The
// old center "All pull requests" view (InboxPane) and its left filter
// rail (InboxSidebar) collapse into this single narrow-rail panel:
//   • filter chips across the top  = the awaiting-review / mine / …
//     bucket views (the "filter views" the user asked to keep), and
//   • a compact scroll list below  = the PRs in the active bucket.
// Clicking a row opens the singleton PRDetailPane in the center via
// `editor.openPrDetail` (fromInbox stays false, so closing the detail
// doesn't try to pop back to a center inbox that no longer exists here).
//
// The header count and the default "All" view reflect OPEN pull requests
// only — merged/closed history no longer inflates the number (it reads as
// PRs "from other projects"). Merged/closed stay reachable via their bucket
// chips, which bucketize the full list. The whole section is collapsible via
// the header chevron (owned by the host so it can reclaim the height).
//
// Data layer is shared with InboxPane through `prsCache`, so the two
// never double-fetch and a label/approve elsewhere repaints this list.

import { useCallback, useEffect, useMemo, useState } from "react";
import { type PrSummary } from "../../lib/api";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  subscribePrList,
} from "../../lib/prsCache";
import {
  bucketize,
  BUCKET_LABEL,
  BUCKET_DOT,
  BUCKET_ORDER,
  type Bucket,
} from "../workpanes/InboxPane";
import { useEditorStore } from "../../lib/editorStore";
import { GhErrorNotice } from "../github/GhErrorNotice";
import { Churn } from "../diff/Churn";
import { AsciiSpinner } from "../ui/ascii-spinner";

// "all" is the implicit default chip; the rest mirror the Inbox buckets.
type Filter = "all" | Bucket;

export function PrRailPanel({
  repoRoot,
  collapsed = false,
  onToggleCollapsed,
}: {
  repoRoot: string;
  /** When true the panel renders only its header; the host reclaims the
   *  freed height. Wired to the chevron when `onToggleCollapsed` is set. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const editor = useEditorStore();
  const cached = getPrListCached(repoRoot);
  const [prs, setPrs] = useState<PrSummary[]>(cached ?? []);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const refresh = useCallback(
    async (force = false) => {
      if (getPrListCached(repoRoot) == null) setLoading(true);
      setError(null);
      try {
        const list = await (force
          ? invalidatePrList(repoRoot)
          : fetchPrList(repoRoot));
        setPrs(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => subscribePrList(repoRoot, (list) => setPrs(list)),
    [repoRoot],
  );

  // OPEN PRs drive the count + the default "All" list; merged/closed history
  // is excluded so the number matches what's actually listed and actionable.
  const openPrs = useMemo(
    () => prs.filter((p) => p.state.toLowerCase() === "open"),
    [prs],
  );
  // Buckets still see the full list so the Merged chip keeps working.
  const buckets = useMemo(() => bucketize(prs), [prs]);
  // Only surface chips that actually have PRs — an empty repo shows just
  // "All", not seven zero-count buckets.
  const activeChips = useMemo(
    () => BUCKET_ORDER.filter((b) => buckets[b].length > 0),
    [buckets],
  );

  const rows =
    filter === "all"
      ? [...openPrs].sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
        )
      : buckets[filter];

  const selected =
    editor.selectedPr?.repoRoot === repoRoot ? editor.selectedPr.number : null;

  return (
    <div className="h-full flex flex-col bg-bg-content">
      {/* Header — click the title/chevron to collapse the whole section */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-line-soft shrink-0">
        <button
          type="button"
          onClick={onToggleCollapsed}
          disabled={!onToggleCollapsed}
          title={collapsed ? "Expand pull requests" : "Collapse pull requests"}
          className="flex items-center gap-1.5 min-w-0 text-text-1 hover:text-text-1 disabled:cursor-default"
        >
          {onToggleCollapsed && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              className={`text-text-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
              aria-hidden
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span className="text-[12px] font-semibold">Pull requests</span>
          <span className="text-text-4 text-[11px] tabular-nums">
            {openPrs.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={loading}
          title="Refresh"
          className="ml-auto w-6 h-6 rounded-md text-text-4 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {collapsed ? null : (
        <>
          {/* Filter chips — the bucket "views" */}
          {activeChips.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2.5 py-2 border-b border-line-soft/60 shrink-0">
              <Chip
                label="All"
                count={openPrs.length}
                dot={null}
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              {activeChips.map((b) => (
                <Chip
                  key={b}
                  label={BUCKET_LABEL[b]}
                  count={buckets[b].length}
                  dot={BUCKET_DOT[b]}
                  active={filter === b}
                  onClick={() => setFilter(b)}
                />
              ))}
            </div>
          )}

          {/* List */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && prs.length === 0 ? (
              <Hint>
                <span className="inline-flex items-center gap-1.5">
                  <AsciiSpinner className="text-[10px]" />
                  Looking for pull requests…
                </span>
              </Hint>
            ) : error ? (
              <GhErrorNotice error={error} onRetry={() => void refresh(true)} />
            ) : rows.length === 0 ? (
              <Hint>
                {filter === "all"
                  ? "No open pull requests."
                  : `Nothing in “${BUCKET_LABEL[filter]}”.`}
              </Hint>
            ) : (
              rows.map((p) => (
                <Row
                  key={p.number}
                  row={p}
                  selected={p.number === selected}
                  onSelect={() =>
                    editor.openPrDetail(repoRoot, p.number, p.title)
                  }
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  dot,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dot: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      <span className="truncate max-w-[120px]">{label}</span>
      <span className="text-text-4 tabular-nums">{count}</span>
    </button>
  );
}

function Row({
  row,
  selected,
  onSelect,
}: {
  row: PrSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  // Colour only where it means "this needs you": a risky change is red, a
  // slightly risky one amber, and "nothing to flag" stays on the neutral ramp
  // rather than painting a green dot on every quiet row.
  const risk =
    row.aura_risk_score !== null && row.aura_risk_score > 60
      ? "bg-red"
      : row.aura_risk_score !== null && row.aura_risk_score > 0
        ? "bg-amber"
        : "bg-text-4/40";
  const decisionTone =
    row.review_decision === "APPROVED"
      ? "text-accent-green"
      : row.review_decision === "CHANGES_REQUESTED"
        ? "text-red"
        : "text-text-4";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 border-b border-line-soft/40 hover:bg-bg-2 transition-colors ${
        selected ? "bg-bg-2" : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${risk}`} />
        <span className="text-[11px] text-text-4 tabular-nums shrink-0">
          #{row.number}
        </span>
        <span className="text-[12px] text-text-1 truncate">{row.title}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 pl-4 text-[11px] text-text-4 min-w-0">
        <span className="truncate">{row.author}</span>
        <span className="font-mono truncate text-text-4/80">
          {row.head_ref}
        </span>
        {row.review_decision && (
          <span className={`shrink-0 ${decisionTone}`}>
            {humanDecision(row.review_decision)}
          </span>
        )}
        {row.checks_state && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              row.checks_state === "success"
                ? "bg-accent-green"
                : row.checks_state === "failure"
                  ? "bg-red"
                  : "bg-amber"
            }`}
            title={
              row.checks_state === "success"
                ? "Checks passed"
                : row.checks_state === "failure"
                  ? "Checks failed"
                  : "Checks still running"
            }
          />
        )}
        <Churn
          additions={row.additions}
          deletions={row.deletions}
          className="ml-auto text-[11px]"
        />
      </div>
    </button>
  );
}

function humanDecision(d: string): string {
  return d
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-4 text-[12px] px-3 py-3 leading-relaxed">
      {children}
    </div>
  );
}
