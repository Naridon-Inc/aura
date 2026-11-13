// Stack view — Stage 7D. Renders the parent/child PR chain rooted at
// the currently-selected PR as a vertical column with arrows.
//
// "Stack" is computed by walking head/base refs across all open PRs in
// the repo (see `pr_stack` Tauri command). We don't need a full SVG DAG
// here because PR stacks are almost always linear — the details panel's
// pull request rows, base first, read better and render zero-cost.
//
// Click a stack node → switches the PR pane's selection to that PR.

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";

import type { PrStackNode } from "../../lib/api";
import { prStack } from "../../lib/prApi";
import { useEditorStore } from "../../lib/editorStore";
import { DetailsCaption } from "../ui/details-panel";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import "../ui/details-pulls.css";
import "../ui/pr-stack.css";

type Props = {
  repoRoot: string;
  prNumber: number;
  /** For a host that only wants the chain when there is one (the Checks
   *  tab): nothing while it loads, fails, or stands alone. */
  quiet?: boolean;
  /** Said on the current pull request's row ("This workspace"). */
  currentLabel?: string;
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

/** The stack the pull request sits in, read once and shared: the chain here
 *  and the Checks tab's Stack row ask through the same cache. */
export function usePrStack(
  repoRoot: string,
  prNumber: number,
): { nodes: PrStackNode[]; loading: boolean; error: string | null } {
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
    // Through prApi, like the overview's stack row, so a fork's checkout
    // asks the upstream repository it was opened against.
    prStack(repoRoot, prNumber)
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

  return { nodes, loading, error };
}

export function PrStackView({ repoRoot, prNumber, quiet = false, currentLabel }: Props) {
  const editor = useEditorStore();
  const { nodes, loading, error } = usePrStack(repoRoot, prNumber);

  if (quiet && (loading || error || nodes.length <= 1)) return null;
  if (loading) {
    return <LoadingState label="Looking for related pull requests…" className="ui-pr-stack-state" />;
  }
  if (error) {
    return (
      <div className="ui-pr-stack-state">
        <ErrorNote>
          <code className="ui-pr-stack-error">{error}</code>
        </ErrorNote>
      </div>
    );
  }
  if (nodes.length <= 1) {
    return (
      <EmptyState
        icon={Layers}
        size="sm"
        title="Not part of a stack"
        body="This change stands on its own. It isn’t built on top of another open pull request, so there’s no chain to show."
        className="ui-pr-stack-empty"
      />
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
    <div className="ui-pr-stack">
      <DetailsCaption>
        {graphiteStack ? (
          <span className="ui-pr-stack-caption">
            <GraphiteMark />
            Stacked with Graphite
          </span>
        ) : (
          `Stack · ${ordered.length} pull requests, base first`
        )}
      </DetailsCaption>
      <ol className="ui-pr-stack-list">
        {ordered.map((n) => {
          const active = n.number === prNumber;
          // Same rule as the PR rail: colour only when there's something
          // to flag, so a clean stack stays quiet.
          const risk =
            n.aura_risk_score !== null && n.aura_risk_score > 0
              ? n.aura_risk_score > 60
                ? "bad"
                : "waiting"
              : "quiet";
          return (
            <li key={n.number}>
              <button
                type="button"
                className="ui-details-pull"
                data-selected={active}
                aria-current={active ? "true" : undefined}
                onClick={() => editor.openPrDetail(repoRoot, n.number, n.title)}
              >
                <div>
                  <span
                    className="ui-details-pull-dot"
                    data-tone={risk}
                    title={
                      risk === "bad"
                        ? "Worth a careful look before merging"
                        : risk === "waiting"
                          ? "A couple of things worth a look"
                          : undefined
                    }
                    aria-hidden
                  />
                  <span className="ui-details-pull-number">#{n.number}</span>
                  <span className="ui-details-pull-title">{n.title}</span>
                  {n.gt_managed && (
                    <span
                      className="ui-pr-stack-gt"
                      title="Parent branch tracked by Graphite (gt)"
                    >
                      <GraphiteMark />
                      gt
                    </span>
                  )}
                </div>
                <div className="ui-details-pull-meta">
                  {n.author && <span>{n.author}</span>}
                  <span className="ui-details-pull-branch">
                    {n.head_ref} → {n.base_ref}
                  </span>
                  {active && currentLabel && (
                    <span className="ui-pr-stack-here">{currentLabel}</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
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
      className="ui-pr-stack-mark"
    >
      <rect x="1.5" y="1.5" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1.5" y="5.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1.5" y="8.9" width="9" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

/** Base first: the root, then down through each pull request built on it. */
export function orderStack(nodes: PrStackNode[]): PrStackNode[] {
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
