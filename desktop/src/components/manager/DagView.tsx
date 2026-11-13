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
import { plainPreview } from "../../lib/plainPreview";
import { truncate } from "../../lib/truncate";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { ErrorNote, LoadingState } from "../ui/state";
import { TaskDetailNote } from "../ui/tasks-detail";
import { CodeMessage } from "../ui/transcript-content";
import "../ui/log-note.css";
import "../ui/dag-view.css";

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
    return <TaskDetailNote>No tasks staged.</TaskDetailNote>;
  }

  return (
    <div ref={containerRef} className="ui-dag">
      <svg className="ui-dag-edges" width="100%" height="100%">
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
      <div className="ui-dag-waves">
        {waves.map((wave, idx) => (
          <section key={idx} className="ui-dag-wave" aria-label={`Wave ${idx + 1}`}>
            <div className="ui-log-note-files-head">
              <span>Wave {idx + 1}</span>
              <span className="ui-log-note-count">{wave.length}</span>
            </div>
            <div className="ui-dag-wave-cards">
              {wave.map((t) => renderCard(t, setCardRef(t.id)))}
            </div>
          </section>
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
  const stroke = STATUS_STROKE[edge.parentStatus] ?? "var(--ui-border)";
  return (
    <g className="ui-dag-edge">
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
      className="ui-tooltip ui-dag-tooltip"
      role="tooltip"
      style={{ left: x, top: y }}
    >
      <strong>
        #{edge.parentId} → #{edge.childId} handover
      </strong>
      {summary ? (
        <p>{truncate(plainSummary, 240)}</p>
      ) : (
        <p className="ui-dag-tooltip-quiet">
          {parent.status === "done"
            ? "(no summary captured)"
            : "Waiting on the task this one depends on."}
        </p>
      )}
      <small>click for full prompt →</small>
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
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="ui-dag-prompt">
        <DialogHeader>
          <DialogTitle>
            Handover #{parentId} → #{childId}
          </DialogTitle>
          <DialogDescription>
            The prompt task #{childId} receives, with what #{parentId} handed over inlined.
          </DialogDescription>
        </DialogHeader>
        <div className="ui-dag-prompt-body">
          {text === null && !error && <LoadingState label="Building prompt…" />}
          {error && <ErrorNote>{error}</ErrorNote>}
          {text && <CodeMessage language="Prompt">{text}</CodeMessage>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_STROKE: Record<ManagerTaskStatus, string> = {
  pending: "var(--ui-border)",
  running: "var(--ui-blue)",
  done: "var(--ui-green)",
  failed: "var(--ui-red)",
  manual_pending: "var(--ui-yellow)",
  skipped: "var(--ui-border)",
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
