// Crew · Canvas — the work as a real node graph on an infinite dotted board,
// the way a vibecoder pictures it: boxes you can pan around, arrows that mean
// "can't start until this is done", parallel work sitting side by side. Same
// unified `ready_view` as the list beside it; the pure `computeCrewGraphLayout`
// decides where every box and arrow goes, this file only makes it a living
// canvas — drag to pan, scroll to zoom, click a node to open its detail.
//
// Connected tasks draw as a left→right flowchart; independent tasks (no
// "waiting on" links) sit as a grid of free nodes, which on a node-canvas reads
// honestly as "these all run in parallel" rather than a broken graph.

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Flag,
  Layers,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RadioTower,
  Sparkles,
  Users,
} from "lucide-react";

import type { ReadyViewDto } from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import {
  computeCrewGraphLayout,
  computeRelatedChain,
  CREW_NODE_W,
  CREW_NODE_H,
  CREW_PAD,
  CREW_CLUSTER_HEADER_H,
  type CrewCluster,
  type CrewClusterStat,
  type CrewGraphNode,
  type CrewNodeStatus,
  type CrewObjective,
  type CrewRegion,
} from "./crewGraphLayout";
import { AssigneeBit } from "./crewShared";
import { bestProof, proofForCommit, type CrewProof } from "./crewProof";
import { CrewLiveTranscript } from "./CrewLiveTranscript";

// A stable empty proof map, so a canvas mounted before the ledger loads (or in a
// repo with no goals) never re-renders on an identity change.
const EMPTY_PROOF: Map<string, CrewProof[]> = new Map();

// Status shows as a small coloured dot only — no screaming border bars.
// Arctic-blue = ready, amber = an agent's on it, green = done, muted =
// waiting/queued. Green stays status-only.
const STATUS_DOT: Record<CrewNodeStatus, string> = {
  ready: "var(--color-accent)",
  working: "#d99a2b",
  done: "#3fa66a",
  blocked: "var(--color-text-5)",
  paused: "var(--color-text-5)",
  other: "var(--color-text-5)",
};
// The same state in one plain word — shown on the card's hover card so "what
// state is this in" reads without decoding the dot colour.
const STATUS_WORD: Record<CrewNodeStatus, string> = {
  ready: "Ready to start",
  working: "An agent is on it",
  done: "Done",
  blocked: "Waiting on earlier work",
  paused: "Paused — held back",
  other: "Queued",
};
// Muted, dark-friendly hues for PARALLEL branches that split off one step — not
// decoration: a colour here means "this line shares an origin with its siblings,
// they run side by side." Kept desaturated so the board stays calm. Final-step
// links override these with green ("heading for the result").
const PARALLEL_HUES = [
  "#6aa5ff", // blue
  "#a78bfa", // violet
  "#4dc1a4", // teal
  "#d99a2b", // amber
  "#d07aa0", // rose
  "#7bb86a", // moss
  "#5fb0d9", // cyan
  "#c98a5e", // clay
];
const hueFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PARALLEL_HUES[h % PARALLEL_HUES.length];
};
const CREW_DONE_GREEN = "#3fa66a";

// A big synced board (900+ tasks) is a tall sheet; allow zooming further out so
// "fit to view" can actually frame the whole thing before you pan in.
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function CrewCanvas({
  view,
  selectedId,
  onSelect,
  proof = EMPTY_PROOF,
  onPlanOrder,
  ordering,
}: {
  view: ReadyViewDto;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Commit → proofs, from the goals ledger. Lets each flow's Result block say
   *  how many finished steps are genuinely proven against their goal. */
  proof?: Map<string, CrewProof[]>;
  /** Auto-order the orderless pile — offered from the "no set order" band so a
   *  flat heap of work has a one-click path to a real connected flow. The brain
   *  works out the dependencies; this fires that automated pass. */
  onPlanOrder?: () => void;
  /** True while that pass is running, so the band shows a spinner. */
  ordering?: boolean;
}) {
  // Goal zones always show their cards now — density is handled by SPREADING the
  // work into spaced zones along the timeline, not by hiding it. The only thing
  // still collapsible is the leftover "no set order yet" pile (epics / sprints /
  // Unsorted), which stays shut as labelled bands you open one at a time.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const layout = useMemo(
    () => computeCrewGraphLayout(view, undefined, expanded),
    [view, expanded],
  );
  // The full chain the selected task belongs to — back to its roots and forward
  // to its ends — so picking one box lights the whole path, not just neighbours.
  const chain = useMemo(
    () => computeRelatedChain(layout, selectedId),
    [layout, selectedId],
  );
  const hasSelection = chain.nodes.size > 0;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // The working node the user chose to "Watch live", if any — we keep its
  // title because that's the key the live transcript links to its agent lane.
  const [watch, setWatch] = useState<{ id: string; title: string } | null>(
    null,
  );
  const watchNode = useCallback(
    (id: string, title: string) => setWatch({ id, title }),
    [],
  );
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );

  const toggleCluster = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Fit the whole graph into view, centred. Called on mount, on the "fit"
  // button, and whenever the graph's size changes (a sync added nodes).
  const fitView = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.width === 0 || layout.height === 0) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const z = clampZoom(
      Math.min(vw / layout.width, vh / layout.height, 1) * 0.92,
    );
    setZoom(z);
    setPan({
      x: (vw - layout.width * z) / 2,
      y: (vh - layout.height * z) / 2,
    });
  }, [layout.width, layout.height]);

  useLayoutEffect(() => {
    fitView();
  }, [fitView]);

  // Drag-to-pan on the board (but not when the drag starts on a node).
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const endDrag = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  // Scroll to zoom, keeping the point under the cursor fixed.
  const onWheel = (e: React.WheelEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const nz = clampZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    if (nz === zoom) return;
    setPan({
      x: mx - ((mx - pan.x) * nz) / zoom,
      y: my - ((my - pan.y) * nz) / zoom,
    });
    setZoom(nz);
  };

  const zoomBy = (factor: number) => {
    const el = containerRef.current;
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    const nz = clampZoom(zoom * factor);
    if (nz === zoom) return;
    setPan({
      x: cx - ((cx - pan.x) * nz) / zoom,
      y: cy - ((cy - pan.y) * nz) / zoom,
    });
    setZoom(nz);
  };

  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  // Zone frames, for drawing the faint goal↔goal interconnections between them.
  const regionPos = new Map(layout.regions.map((r) => [r.id, r] as const));

  // Per-flow data, computed once per layout/proof change so the render stays
  // cheap. A dependency COLUMN is an execution WAVE: everything in column 0 can
  // run at once, then column 1, and so on — that's exactly how the runner picks
  // work up, so the columns ARE the "what runs in parallel vs in sequence" the
  // board needs to show. We also surface:
  //   • roots / sinks  — what the Goal block feeds and what feeds the Result.
  //   • waves          — how many columns (sequential waves) the flow has.
  //   • cols           — each wave's left x + how many run in it, for the labels.
  //   • proven         — finished steps genuinely verified against the goal.
  const regionMeta = useMemo(() => {
    const byRegion = new Map<string, CrewGraphNode[]>();
    for (const n of layout.nodes) {
      if (!n.regionId) continue;
      const arr = byRegion.get(n.regionId);
      if (arr) arr.push(n);
      else byRegion.set(n.regionId, [n]);
    }
    // Only finished work carries a commit, so the proven count joins the done
    // lane's commit_sha to the goals ledger.
    const commitById = new Map<string, string>();
    for (const t of view.done) if (t.commit_sha) commitById.set(t.id, t.commit_sha);
    const meta = new Map<
      string,
      {
        roots: CrewGraphNode[];
        sinks: CrewGraphNode[];
        proven: number;
        waves: number;
        cols: { col: number; x: number; count: number }[];
        labelY: number;
      }
    >();
    for (const [rid, ns] of byRegion) {
      let minCol = Infinity;
      let maxCol = -Infinity;
      let topY = Infinity;
      const byCol = new Map<number, { x: number; count: number }>();
      for (const n of ns) {
        if (n.col < minCol) minCol = n.col;
        if (n.col > maxCol) maxCol = n.col;
        if (n.y < topY) topY = n.y;
        const c = byCol.get(n.col);
        if (c) {
          c.count++;
          if (n.x < c.x) c.x = n.x;
        } else byCol.set(n.col, { x: n.x, count: 1 });
      }
      let proven = 0;
      for (const n of ns) {
        if (n.status !== "done") continue;
        const best = bestProof(proofForCommit(proof, commitById.get(n.id)));
        if (best && best.verdict === "verified") proven++;
      }
      const cols = [...byCol.entries()]
        .map(([col, v]) => ({ col, x: v.x, count: v.count }))
        .sort((p, q) => p.col - q.col);
      meta.set(rid, {
        roots: ns.filter((n) => n.col === minCol),
        sinks: ns.filter((n) => n.col === maxCol),
        proven,
        waves: cols.length,
        cols,
        labelY: topY - 18,
      });
    }
    return meta;
  }, [layout.nodes, view.done, proof]);

  // Edge styling helpers. A node that fans out to ≥2 successors is a PARALLEL
  // SPLIT — those branches run side by side, so we tint that fan with a stable
  // hue keyed to the splitting node, letting the eye follow "these all came from
  // the same step." Single hand-offs stay neutral. An edge landing on a sink
  // (the last step of a flow) goes green — "this leads to the result." Together:
  // green = heading for the finish, a colour = a parallel branch, grey = a plain
  // sequential link.
  const outDeg = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of layout.edges) m.set(e.from, (m.get(e.from) ?? 0) + 1);
    return m;
  }, [layout.edges]);
  const sinkIds = useMemo(() => {
    const s = new Set<string>();
    for (const m of regionMeta.values()) for (const n of m.sinks) s.add(n.id);
    return s;
  }, [regionMeta]);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onWheel={onWheel}
      className="relative h-full w-full overflow-hidden bg-bg-0"
      style={{
        cursor: drag.current ? "grabbing" : "grab",
        // The dotted board. Dots move + scale with the content so panning feels
        // like sliding an infinite sheet under the work.
        backgroundImage:
          "radial-gradient(circle, var(--color-line-soft) 1px, transparent 1px)",
        backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      {/* Flowing-dash animation for a selected task's chain — the dashes stream
          from roots toward ends, so the path reads as a direction, not a static
          highlight. Honours reduced-motion. */}
      <style>{`
        @keyframes crew-edge-flow { to { stroke-dashoffset: -24; } }
        .crew-edge-flow { animation: crew-edge-flow 0.7s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .crew-edge-flow { animation: none; } }
      `}</style>
      {layout.nodes.length === 0 && layout.clusters.length === 0 ? (
        <CanvasEmpty />
      ) : (
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {/* Edges, drawn first so node cards sit on top. */}
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              {/* `context-stroke` makes the arrowhead inherit each edge's own
                  stroke — accent on a selected edge, muted grey otherwise — so
                  it never falls back to SVG's default black fill. */}
              <marker
                id="crew-arrow"
                viewBox="0 0 8 8"
                refX="6.5"
                refY="4"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const onChain = chain.edges.has(i);
              // A link that stays INSIDE one goal lane is the common case —
              // short and local; it reads honestly as "these steps connect". A
              // link that spans two lanes is a long arrow across the board — the
              // spaghetti we're killing — so by default we don't draw it at all.
              // It only appears when you click a task, lighting that task's whole
              // chain (lane-local AND cross-lane) bright and flowing.
              const sameLane = !!(
                a.regionId &&
                b.regionId &&
                a.regionId === b.regionId
              );
              if (hasSelection) {
                // While inspecting, hide far context: keep the picked chain, and
                // lane-local links for orientation; drop everything else.
                if (!onChain && !sameLane) return null;
              } else if (!sameLane) {
                // Resting board: only the local, intra-lane web — never a long
                // cross-board arrow.
                return null;
              }
              const active = hasSelection && onChain;
              const dimmed = hasSelection && !onChain;
              const x1 = a.x + CREW_NODE_W;
              const y1 = a.y + CREW_NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + CREW_NODE_H / 2;
              const dx = Math.max(40, (x2 - x1) / 2);
              // Colour carries meaning: a selected chain is accent; an arrow into
              // a flow's last step is green ("leads to the result"); a fan-out
              // from one step into many takes that step's hue so the parallel
              // branches read as one family; everything else is a plain grey
              // sequential link.
              const restStroke = sinkIds.has(e.to)
                ? CREW_DONE_GREEN
                : (outDeg.get(e.from) ?? 0) >= 2
                  ? hueFor(e.from)
                  : "var(--color-text-3)";
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 6} ${y2}`}
                  fill="none"
                  stroke={active ? "var(--color-accent)" : restStroke}
                  // At rest the intra-zone links ARE the graph — bump them so the
                  // left→right dependency flow reads as the primary structure
                  // (they're all short + local, so density never becomes
                  // spaghetti). A selected chain still overpowers them.
                  strokeWidth={active ? 2.5 : 1.6}
                  strokeOpacity={active ? 1 : dimmed ? 0.1 : 0.5}
                  strokeDasharray={active ? "7 5" : undefined}
                  markerEnd="url(#crew-arrow)"
                  // Flowing dashes animate the direction of a selected chain —
                  // the path visibly streams from roots toward ends.
                  className={active ? "crew-edge-flow" : undefined}
                />
              );
            })}

            {/* Goal↔goal interconnections — a faint, dashed thread between two
                goal zones that genuinely depend on each other. One per linked
                pair (not per task arrow). The endpoints tuck under the zone
                boxes, so only the connecting stretch in the gap shows — reading
                as "these goals are linked" without any spaghetti. Empty when
                goals are self-contained, which is the common, honest case. */}
            {layout.regionEdges.map((e, i) => {
              const a = regionPos.get(e.from);
              const b = regionPos.get(e.to);
              if (!a || !b) return null;
              const acx = a.x + a.width / 2;
              const acy = a.y + a.height / 2;
              const bcx = b.x + b.width / 2;
              const bcy = b.y + b.height / 2;
              const mx = (acx + bcx) / 2;
              return (
                <path
                  key={`re-${i}`}
                  d={`M ${acx} ${acy} C ${mx} ${acy}, ${mx} ${bcy}, ${bcx} ${bcy}`}
                  fill="none"
                  stroke="var(--color-text-4)"
                  strokeWidth={1.5}
                  strokeOpacity={0.22}
                  strokeDasharray="3 7"
                />
              );
            })}

            {/* Bookend connectors — a faint hairline from each flow's Goal block
                out to the steps it kicks off (the dependency roots), and from the
                final steps back into the Result block. They give every flow a
                clear "start here → … → here's what landed" spine without adding
                arrowed clutter: short, calm, one layer-gap each. Dimmed right
                down while a task is selected, so the picked chain stays loud. */}
            {layout.regions.map((r) => {
              const gm = regionMeta.get(r.id);
              if (!gm) return null;
              const op = hasSelection ? 0.08 : 0.3;
              const gx = r.goalBlock.x + r.goalBlock.w;
              const gy = r.goalBlock.y + r.goalBlock.h / 2;
              const rx = r.resultBlock.x;
              const ry = r.resultBlock.y + r.resultBlock.h / 2;
              return (
                <g key={`bk-${r.id}`}>
                  {gm.roots.map((n) => {
                    const x2 = n.x;
                    const y2 = n.y + CREW_NODE_H / 2;
                    const dx = Math.max(28, (x2 - gx) / 2);
                    return (
                      <path
                        key={`gr-${n.id}`}
                        d={`M ${gx} ${gy} C ${gx + dx} ${gy}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke="var(--color-accent)"
                        strokeWidth={1.4}
                        strokeOpacity={op}
                      />
                    );
                  })}
                  {gm.sinks.map((n) => {
                    const x1 = n.x + CREW_NODE_W;
                    const y1 = n.y + CREW_NODE_H / 2;
                    const dx = Math.max(28, (rx - x1) / 2);
                    return (
                      <path
                        key={`sr-${n.id}`}
                        d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${rx - dx} ${ry}, ${rx} ${ry}`}
                        fill="none"
                        stroke="#3fa66a"
                        strokeWidth={1.4}
                        strokeOpacity={op}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {/* Objective sections — the larger goal a few goals roll up to. Drawn
              first (full-width, behind), so its goal-region cards nest visibly
              inside it. This is the "one bigger goal" band. */}
          {layout.objectives.map((o) => (
            <ObjectiveBand key={o.id} objective={o} />
          ))}

          {/* Wave labels — a dependency column is a WAVE: everything in it can run
              at once, then the next wave. Labelling the columns is how the board
              shows "these N run in parallel, then those" without a word of jargon.
              Revealed only once you've zoomed in past the overview, so the fit-to-
              view scatter stays calm. */}
          {zoom >= 0.55
            ? layout.regions.flatMap((r) => {
                const gm = regionMeta.get(r.id);
                if (!gm || gm.waves < 2) return [];
                return gm.cols.map((c) => (
                  <div
                    key={`wave-${r.id}-${c.col}`}
                    data-node
                    className="absolute flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.07em] text-text-5"
                    style={{ left: c.x, top: gm.labelY, width: CREW_NODE_W }}
                  >
                    <span>Wave {c.col + 1}</span>
                    {c.count > 1 ? (
                      <span className="font-normal text-text-4">
                        · {c.count} in parallel
                      </span>
                    ) : null}
                  </div>
                ));
              })
            : null}

          {/* Bookends — every flow opens with a Goal anchor (its identity, the
              agents it'll take, and how many waves) on the far left and closes
              with a Result block ("what's landed, and how far") on the far right.
              The Goal block is now the goal's ONLY label — no separate title strip
              repeating it. The Result block is the only place that does the maths. */}
          {layout.regions.map((r) => (
            <GoalBlock
              key={`goal-${r.id}`}
              region={r}
              waves={regionMeta.get(r.id)?.waves ?? 1}
            />
          ))}
          {layout.regions.map((r) => (
            <ResultBlock
              key={`result-${r.id}`}
              region={r}
              proven={regionMeta.get(r.id)?.proven ?? 0}
            />
          ))}

          {/* The orderless pile gets an honest, secondary band header — never a
              meaningless grid masquerading as a graph. One click plans it into
              a real connected build. */}
          {layout.gridStartY !== null && layout.freeCount > 0 ? (
            <div
              data-node
              className="absolute flex items-center gap-2"
              style={{
                left: CREW_PAD,
                top: layout.gridStartY - 26,
                width: Math.max(layout.width - CREW_PAD * 2, CREW_NODE_W),
              }}
            >
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-5">
                No set order yet · {layout.freeCount}{" "}
                {layout.freeCount === 1 ? "task" : "tasks"}
              </span>
              <span className="h-px flex-1 bg-line-soft" />
              {onPlanOrder ? (
                <button
                  type="button"
                  onClick={ordering ? undefined : onPlanOrder}
                  disabled={ordering}
                  className="inline-flex items-center gap-1 rounded-full border border-line-soft px-2 py-0.5 text-[10.5px] font-medium text-text-3 hover:border-accent hover:text-accent disabled:opacity-60 disabled:hover:border-line-soft disabled:hover:text-text-3"
                  title="Let the brain work out which of these must finish before which, and connect them"
                >
                  {ordering ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Sparkles size={11} />
                  )}
                  {ordering ? "Working out the order…" : "Plan an order"}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Work-group sections — epics, sprints, the Unsorted pile. Each is a
              labelled, collapsible band with a roll-up of what's inside, so a
              900-task board reads as a dozen sections instead of a wall. Drawn
              before the nodes so an expanded group's cards sit on top of it. */}
          {layout.clusters.map((c) => (
            <ClusterBox
              key={c.id}
              cluster={c}
              onToggle={() => toggleCluster(c.id)}
            />
          ))}

          {layout.nodes.map((n) => (
            <CanvasNode
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              dimmed={hasSelection && !chain.nodes.has(n.id)}
              inChain={hasSelection && chain.nodes.has(n.id)}
              onSelect={onSelect}
              onWatch={watchNode}
            />
          ))}
        </div>
      )}

      {/* Watch live — a working node opened into the agent that's building it.
          Self-contained overlay; closes on Esc / X / backdrop click. */}
      {watch ? (
        <CrewLiveTranscript
          nodeTitle={watch.title}
          onClose={() => setWatch(null)}
        />
      ) : null}

      {/* Zoom controls — bottom-right, the node-editor convention. */}
      {layout.nodes.length > 0 || layout.clusters.length > 0 ? (
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-line-soft bg-bg-1/90 p-1 shadow-sm backdrop-blur">
          <CtrlButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <Minus size={13} />
          </CtrlButton>
          <button
            type="button"
            onClick={fitView}
            className="min-w-[42px] rounded px-1.5 py-1 text-[11px] tabular-nums text-text-3 hover:bg-bg-2"
            title="Fit to view"
          >
            {Math.round(zoom * 100)}%
          </button>
          <CtrlButton label="Zoom in" onClick={() => zoomBy(1.2)}>
            <Plus size={13} />
          </CtrlButton>
          <CtrlButton label="Fit to view" onClick={fitView}>
            <Maximize2 size={13} />
          </CtrlButton>
        </div>
      ) : null}
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded text-text-4 hover:bg-bg-2 hover:text-text-1"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function CanvasNode({
  node,
  selected,
  dimmed,
  inChain,
  onSelect,
  onWatch,
}: {
  node: CrewGraphNode;
  selected?: boolean;
  /** A task is selected and this one isn't on its chain — fade it back. */
  dimmed?: boolean;
  /** This task is on the selected task's chain (but isn't the selection). */
  inChain?: boolean;
  onSelect?: (id: string) => void;
  /** Open this (working) node's live agent transcript. Only wired through for
   *  nodes an agent is actively on. */
  onWatch?: (id: string, title: string) => void;
}) {
  const canonical = node.agentKind ? canonicalAgentId(node.agentKind) : null;
  const dot = STATUS_DOT[node.status];
  const done = node.status === "done";
  const working = node.status === "working";
  return (
    <button
      type="button"
      data-node
      onClick={onSelect ? () => onSelect(node.id) : undefined}
      // `z-10 hover:z-50` — a node's hover card overflows its box; without lifting
      // the whole node on hover, later-painted neighbours sit on top of the card
      // and clip it. Hovering raises this node (card included) above all siblings.
      className="group absolute z-10 flex flex-col justify-between rounded-[10px] border border-line-soft bg-bg-0 px-3 py-2.5 text-left transition-all hover:z-50 hover:-translate-y-px hover:border-line-strong"
      style={{
        left: node.x,
        top: node.y,
        width: CREW_NODE_W,
        height: CREW_NODE_H,
        boxShadow: selected
          ? "0 0 0 2px var(--color-accent), 0 4px 14px -6px rgba(0,0,0,0.4)"
          : inChain
            ? "0 0 0 1.5px var(--color-accent), 0 2px 8px -4px rgba(0,0,0,0.3)"
            : "0 1px 2px rgba(0,0,0,0.18)",
        borderColor: selected || inChain ? "var(--color-accent)" : undefined,
        // On-chain cards stay bright; off-chain fade so the path stands out;
        // a done card is always a touch quieter.
        opacity: dimmed ? 0.32 : done ? 0.85 : 1,
      }}
    >
      {/* Title row — the agent avatar grounds it; the teammate who owns it (if
          any) rides alongside; a quiet status dot (or a spinner while an agent's
          on it) sits far-right, the only colour. */}
      <div className="flex min-w-0 items-center gap-2">
        {canonical ? (
          <span className={done ? "opacity-55" : undefined}>
            <AgentIcon
              agentId={canonical}
              label={agentDisplayLabel(canonical)}
              size={16}
            />
          </span>
        ) : (
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-bg-2 text-[8px] font-medium text-text-5">
            ?
          </span>
        )}
        <span
          className={`min-w-0 flex-1 truncate text-[12px] font-medium leading-tight ${
            done ? "text-text-3 line-through decoration-text-5/50" : "text-text-1"
          }`}
        >
          {node.title}
        </span>
        {node.assignee ? <AssigneeBit name={node.assignee} size={15} /> : null}
        {working ? (
          // An agent is on it — offer a way to watch it work. The spinner is
          // the resting state; hovering the card swaps in a "Watch live"
          // affordance that opens the agent's own streaming output. Rendered
          // as a role="button" (the card itself is a <button>, so a nested
          // <button> would be invalid) and it swallows the click so opening
          // the live view never also fires the card's select.
          onWatch ? (
            <span
              role="button"
              tabIndex={0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onWatch(node.id, node.title);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onWatch(node.id, node.title);
                }
              }}
              title="Watch this agent work — open its live output"
              className="shrink-0 cursor-pointer rounded-full p-0.5 text-text-4 hover:bg-accent/12 hover:text-accent"
            >
              {/* Spinner at rest, the watch glyph on card hover. */}
              <Loader2
                size={11}
                className="animate-spin group-hover:hidden"
                style={{ color: dot }}
              />
              <RadioTower size={12} className="hidden group-hover:block" />
            </span>
          ) : (
            <Loader2
              size={11}
              className="shrink-0 animate-spin"
              style={{ color: dot }}
            />
          )
        ) : done ? (
          // A finished step reads as DONE at a glance — a solid green check, not
          // a quiet dot you have to decode. "Once an item is done it should be
          // properly noted."
          <CheckCircle2
            size={13}
            className="shrink-0"
            style={{ color: CREW_DONE_GREEN }}
          />
        ) : (
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: dot }}
          />
        )}
      </div>

      {/* The story — what this task is doing / waiting on / delivered, in plain
          words. This is the line that evolves as the work moves. */}
      <div className="truncate text-[10.5px] leading-snug text-text-4">
        {node.story}
      </div>

      {/* Hover card — a richer read without opening the detail: the full title,
          its state in words, who (robot + teammate) is on it, its priority, and
          where it sits in the flow. Sits below the card, doesn't catch the
          pointer, and only the hovered node's card lifts above its neighbours. */}
      <div className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 hidden w-[260px] rounded-xl border border-line bg-bg-content p-3 text-left shadow-[var(--shadow-modal)] group-hover:block">
        <div className="text-[12px] font-semibold leading-snug text-text-1">
          {node.title}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-3">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: dot }}
          />
          {STATUS_WORD[node.status]}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-4">
          <span className="inline-flex items-center gap-1">
            {canonical ? (
              <AgentIcon
                agentId={canonical}
                label={agentDisplayLabel(canonical)}
                size={13}
              />
            ) : null}
            {canonical ? agentDisplayLabel(canonical) : "No agent yet"}
          </span>
          {node.assignee ? (
            <span className="inline-flex items-center gap-1">
              <AssigneeBit name={node.assignee} size={13} />
              {node.assignee}
            </span>
          ) : null}
          {node.priority && node.priority !== "low" ? (
            <span className="capitalize">{node.priority} priority</span>
          ) : null}
        </div>
        {node.waitingCount > 0 || node.unblockCount > 0 ? (
          <div className="mt-1.5 text-[11px] text-text-4">
            {node.waitingCount > 0
              ? `Waiting on ${node.waitingCount}`
              : ""}
            {node.waitingCount > 0 && node.unblockCount > 0 ? " · " : ""}
            {node.unblockCount > 0 ? `Unblocks ${node.unblockCount}` : ""}
          </div>
        ) : null}
        {node.story ? (
          <div className="mt-1.5 border-t border-line-soft pt-1.5 text-[11px] leading-snug text-text-3">
            {node.story}
          </div>
        ) : null}
      </div>
    </button>
  );
}

// Who's on it + a quiet progress bar — the shape of a group at a glance,
// reused by goal regions and objective sections so every header reads the same.
function RollupChips({ stat }: { stat: CrewClusterStat }) {
  const pct = stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0;
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {stat.agentKinds.slice(0, 3).map((ak) => {
        const c = canonicalAgentId(ak);
        return (
          <AgentIcon key={ak} agentId={c} label={agentDisplayLabel(c)} size={14} />
        );
      })}
      {stat.assignees.length > 0 ? (
        <span className="inline-flex items-center gap-1 text-[10.5px] text-text-4">
          <Users size={12} /> {stat.assignees.length}
        </span>
      ) : null}
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-2"
        title={`${pct}% done`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "#3fa66a" }}
        />
      </div>
    </div>
  );
}

// An OBJECTIVE section — the larger goal a few goals roll up to. NOT a box: a
// vibecoder asked us to drop the outer containers and keep "just the goals
// naming". So this is only a title strip with a hairline under it, marking where
// the objective's band of goals begins; the goal labels + cards sit on the bare
// dotted board below it, grouped by proximity and their own dependency edges.
function ObjectiveBand({ objective }: { objective: CrewObjective }) {
  const { stat } = objective;
  return (
    <div
      className="absolute"
      style={{
        left: objective.x,
        top: objective.y,
        width: objective.width,
      }}
    >
      <div
        className="flex items-center gap-2.5"
        style={{ height: objective.headerHeight }}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <Flag size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-5">
            Objective
          </div>
          <div className="truncate text-[14px] font-semibold leading-tight text-text-1">
            {objective.title}
          </div>
        </div>
        <span className="hidden shrink-0 text-[10.5px] text-text-4 sm:block">
          {objective.regionCount}{" "}
          {objective.regionCount === 1 ? "goal" : "goals"} · {stat.total}{" "}
          {stat.total === 1 ? "step" : "steps"}
          {stat.done > 0 ? ` · ${stat.done} done` : ""}
        </span>
        <RollupChips stat={stat} />
      </div>
      {/* The only line — a faint full-width rule that says "this objective's
          goals start here", without a box wrapping them. */}
      <div className="h-px w-full bg-line-soft/70" />
    </div>
  );
}

// A GOAL ZONE — one goal's worth of work. NOT a box (a vibecoder asked us to
// drop the outer containers and keep "just the goals naming"): this is only the
// goal's TITLE label, sitting in the header strip the layout reserved above its
// cards. The cards below it are grouped by their own proximity + the dependency
// edges that thread through them — no frame needed to say "these belong
// together". Drawn under the cards so they always sit on top.
// The GOAL anchor — the far-left bookend of a flow. A vibecoder asked every flow
// to "start with a goal block" so there's a clear point to read from: this is
// what the steps to its right are building toward. It's also the flow's ONLY
// label (no separate title strip repeating it), so it carries the read of WHO
// works it — the agent avatars — and HOW it's shaped: N steps across M waves
// (a wave = a batch that runs in parallel before the next). The maths of how far
// it's come lives in the Result block at the other end.
function GoalBlock({ region, waves }: { region: CrewRegion; waves: number }) {
  const { goalBlock: g, stat } = region;
  return (
    <div
      data-node
      className="absolute flex flex-col rounded-[10px] border border-accent/35 bg-accent/[0.07] px-3 py-2.5"
      style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
    >
      <div className="flex items-center gap-1.5 text-accent">
        <Flag size={12} />
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em]">
          Goal
        </span>
        {/* Who'll work it — the robots this flow's steps are handed to. */}
        {stat.agentKinds.length > 0 ? (
          <span className="ml-auto flex items-center gap-1">
            {stat.agentKinds.slice(0, 3).map((ak) => {
              const c = canonicalAgentId(ak);
              return (
                <AgentIcon
                  key={ak}
                  agentId={c}
                  label={agentDisplayLabel(c)}
                  size={13}
                />
              );
            })}
          </span>
        ) : null}
      </div>
      <div className="mt-1 line-clamp-2 text-[12px] font-semibold leading-tight text-text-1">
        {region.title}
      </div>
      <div className="mt-auto pt-1 text-[10px] text-text-4">
        {stat.total} {stat.total === 1 ? "step" : "steps"}
        {waves > 1 ? ` · ${waves} waves` : ""}
      </div>
    </div>
  );
}

// The RESULT block — the far-right bookend, the only place that does the maths.
// "What is achieved from this": how far the flow has come (% + done/total), and
// the moat number — how many finished steps are genuinely PROVEN against the
// goal (AST-checked, free, from the goals ledger). When everything's done and
// proven it turns green and says so; until then it's an honest progress note.
function ResultBlock({
  region,
  proven,
}: {
  region: CrewRegion;
  proven: number;
}) {
  const { resultBlock: r, stat } = region;
  const pct = stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0;
  const complete = stat.total > 0 && stat.done === stat.total;
  const allProven = complete && proven === stat.done;
  return (
    <div
      data-node
      className={`absolute flex flex-col rounded-[10px] border px-3 py-2.5 ${
        allProven
          ? "border-[#3fa66a]/45 bg-[#3fa66a]/[0.08]"
          : "border-line bg-bg-1"
      }`}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
    >
      <div
        className={`flex items-center gap-1.5 ${
          allProven ? "text-[#3fa66a]" : "text-text-4"
        }`}
      >
        <CheckCircle2 size={12} />
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em]">
          Result
        </span>
        <span className="ml-auto text-[14px] font-semibold tabular-nums text-text-1">
          {pct}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: allProven ? "#3fa66a" : "var(--color-accent)",
          }}
        />
      </div>
      <div className="mt-auto pt-1.5 text-[10px] leading-snug">
        {allProven ? (
          <span className="font-medium text-[#3fa66a]">
            Delivered &amp; proven · {proven}/{stat.total} checks
          </span>
        ) : (
          <span className="text-text-4">
            {stat.done}/{stat.total} done
            {proven > 0 ? ` · ${proven} proven` : ""}
            {stat.done === 0 ? " · not started" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

// One work-group band — an epic, a sprint, or the Unsorted pile. Header is a
// click-to-toggle button with a plain-language roll-up (how many tasks, how many
// need attention, how many are done, who's on it). Collapsed it's just this
// header; expanded, its task cards render on top of the framed area.
function ClusterBox({
  cluster,
  onToggle,
}: {
  cluster: CrewCluster;
  onToggle: () => void;
}) {
  const { stat } = cluster;
  const pct = stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0;
  const kindLabel =
    cluster.kind === "epic"
      ? "Epic"
      : cluster.kind === "sprint"
        ? "Sprint"
        : "Loose tasks";
  return (
    <div
      data-node
      className="absolute rounded-2xl border border-line-soft bg-bg-1/25"
      style={{
        left: cluster.x,
        top: cluster.y,
        width: cluster.width,
        height: cluster.height,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 rounded-2xl px-3 text-left hover:bg-bg-2/40"
        style={{ height: CREW_CLUSTER_HEADER_H }}
        title={cluster.expanded ? "Collapse this group" : "Open this group"}
      >
        {cluster.expanded ? (
          <ChevronDown size={15} className="shrink-0 text-text-4" />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-text-4" />
        )}
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-bg-2 text-text-4">
          <Layers size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text-1">
              {cluster.title}
            </span>
            <span className="shrink-0 rounded-full bg-bg-2 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.06em] text-text-5">
              {kindLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-text-4">
            {stat.total} {stat.total === 1 ? "task" : "tasks"}
            {stat.attention > 0 ? ` · ${stat.attention} need attention` : ""}
            {stat.done > 0 ? ` · ${stat.done} done` : ""}
            {stat.working > 0 ? ` · ${stat.working} in progress` : ""}
          </div>
        </div>
        {/* Who's on it + a quiet progress bar — the shape of the group at a
            glance, without opening it. */}
        <div className="flex shrink-0 items-center gap-2.5">
          {stat.agentKinds.slice(0, 3).map((ak) => {
            const c = canonicalAgentId(ak);
            return (
              <AgentIcon
                key={ak}
                agentId={c}
                label={agentDisplayLabel(c)}
                size={14}
              />
            );
          })}
          {stat.assignees.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-text-4">
              <Users size={12} /> {stat.assignees.length}
            </span>
          ) : null}
          <div
            className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-2"
            title={`${pct}% done`}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${pct}%`, background: "#3fa66a" }}
            />
          </div>
        </div>
      </button>
    </div>
  );
}

function CanvasEmpty() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[12px] text-text-5">Nothing to plot yet.</p>
    </div>
  );
}
