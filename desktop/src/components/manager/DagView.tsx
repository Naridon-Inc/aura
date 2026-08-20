// DAG view for a Manager session — task cards grouped by computed
// dependency depth ("waves"), with SVG edges drawn between dependent
// cards so the user can see *which task feeds which*. Hover an edge to
// see the upstream summary that will be inlined into the downstream
// prompt; click the edge to expand the full handover prompt that the
// downstream agent actually receives (rendered by the backend's
// `manager_preview_prompt` which calls `prompt::build_prompt`).
//
// Extracted from `ManagerSurface.tsx::DagView` so the edge layer can
// own its own coordinate measurement (ResizeObserver on the wave grid
// + getBoundingClientRect on each card) without dragging that into the
// surrounding three-pane layout.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, type ManagerTask, type ManagerTaskStatus } from "../../lib/api";
import { Button } from "../ui/button";
import { plainPreview } from "../../lib/plainPreview";
import { truncate } from "../../lib/truncate";

type DagViewProps = {
  tasks: ManagerTask[];
  sessionId: string;
  selectedTaskId: number | null;
  onSelectTask: (id: number) => void;
  /** TaskCard renderer is owned by the parent so action menus + click
   *  affordances stay co-located with the surface, but DAG layout +
   *  edges live here. */
  renderCard: (task: ManagerTask, ref: (el: HTMLDivElement | null) => void) => React.ReactNode;
};

type EdgeGeom = {
  parentId: number;
  childId: number;
  parentStatus: ManagerTaskStatus;
  // Coordinates relative to the SVG viewport (== the wave-grid bounds).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function DagView({
  tasks,
  sessionId,
  selectedTaskId,
  onSelectTask,
  renderCard,
}: DagViewProps) {
  const waves = useMemo(() => groupByDepth(tasks), [tasks]);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<EdgeGeom[]>([]);
  const [hoverEdge, setHoverEdge] = useState<EdgeGeom | null>(null);
  const [expandedEdge, setExpandedEdge] = useState<EdgeGeom | null>(null);

  const setCardRef = useCallback((id: number) => {
    return (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    };
  }, []);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerBox = container.getBoundingClientRect();
    const out: EdgeGeom[] = [];
    for (const child of tasks) {
      for (const parentId of child.depends_on) {
        const parent = tasks.find((t) => t.id === parentId);
        if (!parent) continue;
        const childEl = cardRefs.current.get(child.id);
        const parentEl = cardRefs.current.get(parentId);
        if (!childEl || !parentEl) continue;
        const pb = parentEl.getBoundingClientRect();
        const cb = childEl.getBoundingClientRect();
        out.push({
          parentId,
          childId: child.id,
          parentStatus: parent.status,
          x1: pb.right - containerBox.left,
          y1: pb.top + pb.height / 2 - containerBox.top,
          x2: cb.left - containerBox.left,
          y2: cb.top + cb.height / 2 - containerBox.top,
        });
      }
    }
    setEdges(out);
  }, [tasks]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, waves]);

  // Cards reflow on container resize (window resize, sidebar toggle,
  // adjacent panel widths shifting). ResizeObserver is cheap and lets
  // us drop the layout-thrash of MutationObserver on body.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(containerRef.current);
    for (const el of cardRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [recompute, tasks.length]);

  if (tasks.length === 0) {
    return <div className="text-text-3 text-sm">No tasks staged.</div>;
  }

  return (
    <div ref={containerRef} className="relative">
      <svg
        className="absolute inset-0 pointer-events-none"
        width="100%"
        height="100%"
        style={{ overflow: "visible" }}
      >
        {edges.map((e) => (
          <Edge
            key={`${e.parentId}-${e.childId}`}
            edge={e}
            isHover={hoverEdge?.parentId === e.parentId && hoverEdge?.childId === e.childId}
            onMouseEnter={() => setHoverEdge(e)}
            onMouseLeave={() => setHoverEdge(null)}
            onClick={() => setExpandedEdge(e)}
          />
        ))}
      </svg>
      <div className="flex flex-col gap-3 relative">
        {waves.map((wave, idx) => (
          <div key={idx}>
            <div className="section-label mb-1">
              Wave {idx + 1}
            </div>
            <div className="flex flex-wrap gap-x-12 gap-y-2">
              {wave.map((t) => renderCard(t, setCardRef(t.id)))}
            </div>
          </div>
        ))}
      </div>
      {hoverEdge && !expandedEdge && (
        <EdgeTooltip edge={hoverEdge} tasks={tasks} />
      )}
      {expandedEdge && (
        <PromptPreviewModal
          sessionId={sessionId}
          parentId={expandedEdge.parentId}
          childId={expandedEdge.childId}
          onClose={() => setExpandedEdge(null)}
        />
      )}
      {/* Re-export to keep the old API */}
      {selectedTaskId !== null && void onSelectTask /* keep callback in scope */}
    </div>
  );
}

function Edge({
  edge,
  isHover,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: {
  edge: EdgeGeom;
  isHover: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}) {
  // Quadratic curve — control point sits halfway between, pulled down
  // a bit so two edges between the same wave pair don't overlap into a
  // single line. dx/2 vertical offset reads like a soft fan.
  const dx = edge.x2 - edge.x1;
  const dy = edge.y2 - edge.y1;
  const cx = edge.x1 + dx / 2;
  const cy = edge.y1 + dy / 2 + Math.min(40, Math.abs(dx) * 0.18);
  const path = `M ${edge.x1} ${edge.y1} Q ${cx} ${cy} ${edge.x2} ${edge.y2}`;
  const stroke = STATUS_STROKE[edge.parentStatus] ?? "var(--color-line)";
  return (
    <g style={{ pointerEvents: "auto", cursor: "pointer" }}>
      {/* Wide invisible hit-target so hover is forgiving. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={isHover ? 2 : 1.4}
        strokeLinecap="round"
        opacity={isHover ? 1 : 0.7}
      />
      {/* Arrowhead at the child's edge. */}
      <ArrowHead x={edge.x2} y={edge.y2} angle={Math.atan2(dy, dx)} color={stroke} />
    </g>
  );
}

function ArrowHead({ x, y, angle, color }: { x: number; y: number; angle: number; color: string }) {
  const size = 5;
  const a1x = x - size * Math.cos(angle - Math.PI / 6);
  const a1y = y - size * Math.sin(angle - Math.PI / 6);
  const a2x = x - size * Math.cos(angle + Math.PI / 6);
  const a2y = y - size * Math.sin(angle + Math.PI / 6);
  return (
    <polygon
      points={`${x},${y} ${a1x},${a1y} ${a2x},${a2y}`}
      fill={color}
      opacity={0.9}
    />
  );
}

function EdgeTooltip({ edge, tasks }: { edge: EdgeGeom; tasks: ManagerTask[] }) {
  const parent = tasks.find((t) => t.id === edge.parentId);
  if (!parent) return null;
  // Handovers are written by an agent, so they arrive as markdown. A tooltip
  // four lines tall is no place for a heading marker. See plainPreview.ts.
  const summary = parent.summary?.trim();
  const plainSummary = plainPreview(summary ?? "");
  const x = (edge.x1 + edge.x2) / 2;
  const y = (edge.y1 + edge.y2) / 2 + 14;
  return (
    <div
      className="absolute z-20 pointer-events-none bg-bg-1 border border-line rounded shadow-lg px-2 py-1.5 text-xs max-w-xs"
      style={{ left: x, top: y, transform: "translateX(-50%)" }}
    >
      <div className="section-label mb-0.5">
        #{edge.parentId} → #{edge.childId} handover
      </div>
      {summary ? (
        <div className="text-text-1 whitespace-pre-wrap line-clamp-4">
          {truncate(plainSummary, 240)}
        </div>
      ) : (
        <div className="text-text-3 italic">
          {parent.status === "done"
            ? "(no summary captured)"
            : "Waiting on the task this one depends on."}
        </div>
      )}
      <div className="text-text-3 text-2xs mt-1">click for full prompt →</div>
    </div>
  );
}

function PromptPreviewModal({
  sessionId,
  parentId,
  childId,
  onClose,
}: {
  sessionId: string;
  parentId: number;
  childId: number;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .managerPreviewPrompt(sessionId, childId)
      .then((p) => {
        if (!cancelled) setText(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, childId]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-bg-1 border border-line rounded-lg shadow-xl w-[640px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-line-soft">
          <div className="section-label">
            Handover #{parentId} → #{childId}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-text-3 hover:text-text-1 text-xs"
            onClick={onClose}
          >
            ✕
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {text === null && !error && (
            <div className="text-text-3 text-xs">Building prompt…</div>
          )}
          {error && <div className="text-red text-xs">{error}</div>}
          {text && (
            <pre className="text-sm text-text-1 whitespace-pre-wrap font-mono">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_STROKE: Record<ManagerTaskStatus, string> = {
  pending: "var(--color-line)",
  running: "var(--color-blue)",
  done: "var(--color-green)",
  failed: "var(--color-red)",
  manual_pending: "var(--color-amber)",
  skipped: "var(--color-line)",
};

function groupByDepth(tasks: ManagerTask[]): ManagerTask[][] {
  const depth = new Map<number, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      const d =
        t.depends_on.length === 0
          ? 0
          : Math.max(0, ...t.depends_on.map((dep) => (depth.get(dep) ?? -1) + 1));
      if (depth.get(t.id) !== d) {
        depth.set(t.id, d);
        changed = true;
      }
    }
  }
  const max = Math.max(0, ...Array.from(depth.values()));
  const waves: ManagerTask[][] = Array.from({ length: max + 1 }, () => []);
  for (const t of tasks) {
    const d = depth.get(t.id) ?? 0;
    waves[d].push(t);
  }
  return waves.filter((w) => w.length > 0);
}
