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
    return <div className="px-3 py-3 text-text-4 text-[12px]">loading…</div>;
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
      <div className="px-3 py-3 text-text-4 text-[12px]">
        no stack — this PR doesn't share a head/base ref with any other open PR.
      </div>
    );
  }

  // Order: walk from root down through children. We arrange depth-first
  // by base/head linkage. For typical linear stacks this just orders top
  // → bottom.
  const ordered = orderStack(nodes);

  return (
    <div className="px-2 py-2 space-y-1">
      {ordered.map((n, i) => {
        const active = n.number === prNumber;
        return (
          <div key={n.number}>
            <button
              type="button"
              onClick={() =>
                editor.openPrDetail(repoRoot, n.number, n.title)
              }
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left ${
                active
                  ? "bg-accent-violet/20 border border-accent-violet/40"
                  : "hover:bg-bg-2 border border-transparent"
              }`}
            >
              <span className="text-[11px] text-text-4 tabular-nums w-10 flex-shrink-0">
                #{n.number}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-text-1 truncate">{n.title}</div>
                <div className="text-[10.5px] text-text-4 font-mono truncate">
                  {n.head_ref} → {n.base_ref}
                </div>
              </div>
              {n.aura_risk_score !== null && (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background:
                      n.aura_risk_score > 60
                        ? "var(--color-red)"
                        : n.aura_risk_score > 0
                          ? "#d59f4f"
                          : "var(--color-accent-green)",
                  }}
                  title={`risk ${n.aura_risk_score}`}
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
