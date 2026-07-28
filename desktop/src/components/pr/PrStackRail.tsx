// PrStackRail — Stage 8B. Graphite-style stack visualization for the
// Overview tab. Vertical line on the left with per-PR avatar dots,
// branch icon, title, status pill, comment count, +/- chip, age.
//
// Differences from PrStackView (Stage 7D):
//  - Inline horizontal layout per row (vs the existing card grid).
//  - Highlights the active PR by setting a "current" treatment.
//  - Status pill mirrors Graphite phrasing: Waiting on your review /
//    Required checks failed / Ready to merge / Approved / Merged.
//
// Click a node → focuses that PR's detail (calls editorStore.openPrDetail).

import { useEffect, useState } from "react";
import { api, type PrStackNode, type PrSummary } from "../../lib/api";
import { fetchPrList } from "../../lib/prsCache";
import { useEditorStore } from "../../lib/editorStore";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { Churn } from "../diff/Churn";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  repoRoot: string;
  prNumber: number;
  /** Active viewer login (from pr_whoami) — drives the
   *  "Waiting on your review" pill. */
  viewer?: string;
};

export function PrStackRail({ repoRoot, prNumber, viewer }: Props) {
  const editor = useEditorStore();
  const [stack, setStack] = useState<PrStackNode[]>([]);
  const [summaries, setSummaries] = useState<Map<number, PrSummary>>(new Map());
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.prStack(repoRoot, prNumber).catch(() => [] as PrStackNode[]),
      fetchPrList(repoRoot).catch(() => [] as PrSummary[]),
    ])
      .then(([nodes, list]) => {
        if (cancelled) return;
        setStack(nodes);
        const map = new Map<number, PrSummary>();
        for (const p of list) map.set(p.number, p);
        setSummaries(map);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, prNumber]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-text-4 text-[12px] py-3">
        <AsciiSpinner className="text-[10px]" />
        <span>Looking for related pull requests…</span>
      </div>
    );
  }
  if (stack.length === 0) {
    return null;
  }

  // Order nodes so the parent (lowest in the chain) renders first;
  // PrStackNode carries .parent so we can topo-sort.
  const ordered = topoSort(stack);
  const activeIdx = ordered.findIndex((n) => n.number === prNumber);

  return (
    <section className="border border-line-soft rounded-lg bg-bg-content">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2.5 px-4 h-10 hover:bg-bg-2 transition-colors"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 10 10"
          className={`text-text-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
        <StackIcon />
        <span className="text-[12px] font-semibold text-text-1">Stack</span>
        <span className="text-[11px] text-text-4 tabular-nums">
          {Math.max(activeIdx + 1, 1)} of {ordered.length}
        </span>
      </button>
      {!collapsed && (
        <div className="px-2 pb-2 relative">
          {/* vertical rail — connects every PR dot down to the trunk anchor */}
          <div className="absolute left-[26px] top-0 bottom-7 w-px bg-line-soft" />
          {ordered.map((n, i) => (
            <Row
              key={n.number}
              node={n}
              summary={summaries.get(n.number)}
              active={n.number === prNumber}
              isFirst={i === 0}
              isLast={i === ordered.length - 1}
              viewer={viewer}
              onSelect={() =>
                editor.openPrDetail(repoRoot, n.number, n.title)
              }
            />
          ))}
          <TrunkAnchor baseRef={ordered[0]?.base_ref} />
        </div>
      )}
    </section>
  );
}

function TrunkAnchor({ baseRef }: { baseRef?: string | null }) {
  const ref = baseRef && baseRef.length > 0 ? baseRef : "main";
  return (
    <div className="flex items-center gap-3 pl-2 pr-3 py-1.5">
      <div className="relative w-7 flex justify-center flex-shrink-0">
        <span className="relative z-10 w-3 h-3 rounded-full bg-line-soft border border-line-strong" />
      </div>
      <span className="text-[11.5px] font-mono text-text-3">{ref}</span>
      <span className="text-[11px] text-text-4">(trunk)</span>
    </div>
  );
}

function Row({
  node,
  summary,
  active,
  isFirst,
  isLast,
  viewer,
  onSelect,
}: {
  node: PrStackNode;
  summary: PrSummary | undefined;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  viewer?: string;
  onSelect: () => void;
}) {
  void isFirst;
  void isLast;
  const pill = derivePill(node, summary, viewer);
  const additions = summary?.additions ?? 0;
  const deletions = summary?.deletions ?? 0;
  const updated = summary?.updated_at ?? "";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 pl-2 pr-3 py-2 rounded-md text-left transition-colors ${
        active ? "bg-bg-2" : "hover:bg-bg-2/60"
      }`}
    >
      {/* avatar dot column */}
      <div className="relative w-7 flex justify-center flex-shrink-0">
        <span
          className={`relative z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-bold uppercase ${
            active ? "" : "border-line bg-bg-1 text-text-3"
          }`}
          style={
            active
              ? {
                  borderColor:
                    "color-mix(in srgb, var(--color-violet) 70%, transparent)",
                  background:
                    "color-mix(in srgb, var(--color-violet) 30%, transparent)",
                  color: "var(--color-violet)",
                }
              : undefined
          }
          title={node.author}
        >
          {(node.author || "?").charAt(0)}
        </span>
      </div>
      {/* branch icon */}
      <BranchIcon className="text-text-4 flex-shrink-0" />
      {/* title */}
      <span
        className={`flex-1 min-w-0 truncate text-[12.5px] ${
          active ? "text-text-1" : "text-text-2"
        }`}
      >
        {node.title}
      </span>
      {/* status pill */}
      {pill && (
        <StatusChip tone={pill.tone} dense>
          {pill.label}
        </StatusChip>
      )}
      {/* +/− chip */}
      <Churn additions={additions} deletions={deletions} />
      {/* age */}
      <span className="text-[11px] tabular-nums text-text-4 w-10 text-right">
        {formatAge(updated)}
      </span>
    </button>
  );
}

function derivePill(
  node: PrStackNode,
  summary: PrSummary | undefined,
  viewer?: string,
): { label: string; tone: ChipTone } | null {
  if (node.state === "MERGED") {
    return { label: "Merged", tone: "violet" };
  }
  if (node.is_draft) {
    return { label: "Draft", tone: "neutral" };
  }
  if (!summary) return null;
  if (summary.checks_state === "failure") {
    return { label: "Required checks failed", tone: "red" };
  }
  if (
    summary.is_review_requested_for_me ||
    (viewer && summary.review_decision === "REVIEW_REQUIRED")
  ) {
    return { label: "Waiting on your review", tone: "amber" };
  }
  if (summary.review_decision === "CHANGES_REQUESTED") {
    return { label: "Changes requested", tone: "red" };
  }
  if (summary.review_decision === "APPROVED") {
    return { label: "Ready to merge", tone: "green" };
  }
  return null;
}

function topoSort(nodes: PrStackNode[]): PrStackNode[] {
  // Walk parent links from each node back to root, then collect roots
  // and DFS forward. Cycles can't occur in a real PR stack but we
  // bail-out at 64 hops just in case.
  const byNum = new Map<number, PrStackNode>();
  for (const n of nodes) byNum.set(n.number, n);
  const roots: PrStackNode[] = [];
  for (const n of nodes) {
    if (n.parent == null || !byNum.has(n.parent)) {
      roots.push(n);
    }
  }
  const out: PrStackNode[] = [];
  const seen = new Set<number>();
  function dfs(n: PrStackNode, depth: number) {
    if (depth > 64 || seen.has(n.number)) return;
    seen.add(n.number);
    out.push(n);
    for (const c of n.children) {
      const child = byNum.get(c);
      if (child) dfs(child, depth + 1);
    }
  }
  for (const r of roots) dfs(r, 0);
  // Catch any orphans not reached via roots
  for (const n of nodes) {
    if (!seen.has(n.number)) out.push(n);
  }
  return out;
}

function StackIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1l6 3-6 3-6-3 6-3zM2 8l6 3 6-3M2 12l6 3 6-3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchIcon({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <circle cx="4" cy="3" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 5v6M12 11V8a3 3 0 00-3-3H6.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
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
