// Stack view — Stage 7D. Renders the parent/child PR chain rooted at
// the currently-selected PR as a vertical column with arrows.
//
// "Stack" is computed by walking head/base refs across all open PRs in
// the repo (see `pr_stack` Tauri command). We don't need a full SVG DAG
// here because PR stacks are almost always linear — a column of cards
// with up/down arrows reads better and renders zero-cost.
//
// Click a stack node → switches the PR pane's selection to that PR.

import { useEffect, useState } from "react";
import { api, type PrStackNode } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  repoRoot: string;
  prNumber: number;
};

// Module-level SWR cache. The right rail mounts PrStackView only while the
// "Stack" tab is active (`{rightTab === "stack" && …}`), so every tab toggle
// unmounts + remounts it — without a cache that re-runs `api.prStack` (a
// `gh pr list` walk) and re-flashes "loading…" each time. We paint the warm
// result instantly and refresh quietly in the background; a 30s TTL keeps
// the stack reasonably fresh without hammering gh on rapid tab-flipping.
const STACK_CACHE = new Map<string, { nodes: PrStackNode[]; ts: number }>();
const STACK_TTL_MS = 30_000;
const stackKey = (repoRoot: string, prNumber: number) =>
  `${repoRoot}::${prNumber}`;

export function PrStackView({ repoRoot, prNumber }: Props) {
  const editor = useEditorStore();
  const warm = STACK_CACHE.get(stackKey(repoRoot, prNumber));
  const [nodes, setNodes] = useState<PrStackNode[]>(warm?.nodes ?? []);
  const [error, setError] = useState<string | null>(null);
  // No spinner when we already have a warm payload — background refresh
  // swaps it silently if the stack changed.
  const [loading, setLoading] = useState(warm == null);

  useEffect(() => {
    let cancelled = false;
    const cached = STACK_CACHE.get(stackKey(repoRoot, prNumber));
    if (cached) {
      setNodes(cached.nodes);
      setLoading(false);
    } else {
      setNodes([]);
      setLoading(true);
    }
    setError(null);
    // Skip the network entirely when the cached payload is still fresh.
    if (cached && Date.now() - cached.ts < STACK_TTL_MS) {
      return () => {
        cancelled = true;
      };
    }
    api
      .prStack(repoRoot, prNumber)
      .then((s) => {
        STACK_CACHE.set(stackKey(repoRoot, prNumber), { nodes: s, ts: Date.now() });
        if (cancelled) return;
        setNodes(s);
      })
      .catch((e) => {
        if (cancelled) return;
        // Keep any warm nodes on screen; only surface an error on cold load.
        if (!cached) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, prNumber]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-3 text-text-4 text-[12px]">
        <AsciiSpinner className="text-[10px]" />
        <span>Looking for related pull requests…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-3 py-3 text-[11px] text-red font-mono whitespace-pre-wrap">
        {error}
      </div>
    );
  }
  if (nodes.length <= 1) {
    return (
      <div className="px-3 py-3 text-text-4 text-[12px] leading-relaxed">
        This change stands on its own — it isn’t built on top of another open
        pull request, so there’s no chain to show.
      </div>
    );
  }

  // Order: walk from root down through children. We arrange depth-first
  // by base/head linkage. For typical linear stacks this just orders top
  // → bottom.
  const ordered = orderStack(nodes);
  // Graphite owns this stack when any branch's parent came from its local
  // stack metadata rather than the GitHub base ref — surface that so the
  // reviewer knows the chain is `gt`'s, not head/base inference.
  const graphiteStack = ordered.some((n) => n.gt_managed);

  return (
    <div className="px-2 py-2 space-y-1">
      {graphiteStack && (
        <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[10.5px] uppercase tracking-wider text-text-4">
          <GraphiteMark />
          Stacked with Graphite
        </div>
      )}
      {ordered.map((n, i) => {
        const active = n.number === prNumber;
        return (
          <div key={n.number}>
            <button
              type="button"
              onClick={() =>
                editor.openPrDetail(repoRoot, n.number, n.title)
              }
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
                active
                  ? "bg-bg-2 border border-line-soft"
                  : "hover:bg-bg-2/60 border border-transparent"
              }`}
            >
              <span className="text-[11px] text-text-4 tabular-nums w-10 flex-shrink-0">
                #{n.number}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-text-1 truncate">{n.title}</span>
                  {n.gt_managed && (
                    <span
                      className="flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-text-4 border border-line-soft rounded px-1 py-px flex-shrink-0"
                      title="Parent branch tracked by Graphite (gt)"
                    >
                      <GraphiteMark />
                      gt
                    </span>
                  )}
                </div>
                <div className="text-[10.5px] text-text-4 font-mono truncate">
                  {n.head_ref} → {n.base_ref}
                </div>
              </div>
              {/* Same rule as the PR rail: colour only when there's something
                  to flag, so a clean stack stays quiet. */}
              {n.aura_risk_score !== null && n.aura_risk_score > 0 && (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background:
                      n.aura_risk_score > 60
                        ? "var(--color-red)"
                        : "var(--color-amber)",
                  }}
                  title={
                    n.aura_risk_score > 60
                      ? "Worth a careful look before merging"
                      : "A couple of things worth a look"
                  }
                />
              )}
            </button>
            {i + 1 < ordered.length && (
              <div className="text-text-4 text-[12px] text-center">↓</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Graphite's mark — three stacked bars, echoing a stack of branches. Inline
// SVG (no asset, no network) so it renders anywhere the chip does.
function GraphiteMark() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className="flex-shrink-0"
    >
      <rect x="1.5" y="1.5" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1.5" y="5.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1.5" y="8.9" width="9" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function orderStack(nodes: PrStackNode[]): PrStackNode[] {
  const byNumber = new Map(nodes.map((n) => [n.number, n]));
  // Find the topmost ancestor — node whose parent is null.
  const root = nodes.find((n) => n.parent === null);
  if (!root) return nodes;
  const out: PrStackNode[] = [];
  const seen = new Set<number>();
  const walk = (n: PrStackNode) => {
    if (seen.has(n.number)) return;
    seen.add(n.number);
    out.push(n);
    for (const childNum of n.children) {
      const child = byNumber.get(childNum);
      if (child) walk(child);
    }
  };
  walk(root);
  // Stragglers — anything not reachable from root, append in number order.
  for (const n of nodes) {
    if (!seen.has(n.number)) out.push(n);
  }
  return out;
}
