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
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Flag,
  Layers,
  Maximize2,
  Minus,
  Network,
  Plus,
  RadioTower,
  Sparkles,
  Users,
} from "lucide-react";

import type { LoopTask, ReadyViewDto } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Progress } from "../../ui/progress";
import { EmptyState } from "../../ui/state";
import { TaskFact } from "../../ui/tasks-board";
import { TaskStatusBadge } from "../../ui/tasks-status";
import { WorkspaceStageIcon, type WorkspaceStage } from "../../ui/workspace-preview-card";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import {
  computeCrewGraphLayout,
  computeRelatedChain,
  CREW_NODE_W,
  CREW_NODE_H,
  CREW_PAD,
  CREW_CLUSTER_HEADER_H,
  type BoardStepsByTaskId,
  type CrewCluster,
  type CrewClusterStat,
  type CrewGraphNode,
  type CrewObjective,
  type CrewRegion,
} from "./crewGraphLayout";
import { AssigneeBit } from "./crewShared";
import { bestProof, proofForCommit, type CrewProof } from "./crewProof";
import { CrewLiveTranscript } from "./CrewLiveTranscript";
import { WORK_STATE, nodeState, type WorkState } from "../../../lib/workState";
import { percent } from "../../../lib/percent";
import "../../ui/code-map.css";
import "../../ui/crew-canvas.css";

// A stable empty proof map, so a canvas mounted before the ledger loads (or in a
// repo with no goals) never re-renders on an identity change.
const EMPTY_PROOF: Map<string, CrewProof[]> = new Map();

// Status shows as a small coloured dot only — no screaming border bars. Both
// the dot and the word beside it come from lib/workState, so a node reads the
// same here, in the plan sidebar and in the live transcript.
// Muted, dark-friendly hues for PARALLEL branches that split off one step — not
// decoration: a colour here means "this line shares an origin with its siblings,
// they run side by side." Kept desaturated so the board stays calm. Final-step
// links override these with green ("heading for the result").
const PARALLEL_HUES = [
  "#6aa5ff", // blue
  "#a78bfa", // violet
  "#4dc1a4", // teal
  "#d9a441", // amber
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
// The board's own colours for what an edge means. Library tokens, so the
// canvas follows the theme the cards beside it follow.
const CREW_DONE_GREEN = "var(--ui-green)";
const CREW_PICKED = "var(--ui-link)";
const CREW_EDGE_GREY = "var(--ui-muted-fg)";
const CREW_REGION_THREAD = "var(--ui-faint)";

// A big synced board (900+ tasks) is a tall sheet; allow zooming further out so
// "fit to view" can actually frame the whole thing before you pan in.
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.6;
// …but do not *arrive* down there. Fitting is a means, not the goal: below
// roughly half size the task titles stop being words, and this project's
// fifty-one nodes fitted to 20% — the floor — so the graph opened as grey
// confetti. Fit shrinks to READABLE_ZOOM and no further, then anchors the
// first task top-left and lets you pan to the rest. Seeing part of a graph you
// can read beats seeing all of one you can't.
const READABLE_ZOOM = 0.55;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// How far past the visible frame we keep cards mounted, in board pixels.
// Generous enough that a fast pan never shows a hole before React catches up.
const CULL_MARGIN = CREW_NODE_W * 2;

// ── Layout memo keys ──────────────────────────────────────────────────────
//
// The board polls, and every tick hands us a brand-new `ReadyViewDto` even
// when not one task moved. Keyed on that object, the (expensive) layout pass
// re-ran on every tick for a 900-task board. These fingerprints let the memos
// key on the WORK instead of the object identity: same string ⇒ same picture.
//
// `updated_at` stands in for the free-text fields the layout reads (title,
// input) so we never have to hash task bodies — any edit to them moves the
// timestamp. Everything the grouping depends on (tags, deps, parent, agent,
// assignee, priority) is spelled out, because those decide which zone a card
// lands in and we'd rather over-specify than miss a regroup.
//
// The separators are control characters, so a task's own text can never forge
// a field boundary and make two different boards fingerprint alike.
const KEY_SEP = "\u0001";
const LANE_SEP = "\u0002";

function laneKey(tasks: readonly LoopTask[]): string {
  const parts: string[] = [];
  for (const t of tasks) {
    parts.push(
      t.id,
      String(t.updated_at),
      t.priority,
      t.agent_kind ?? "",
      t.assignee ?? "",
      t.parent_task_id ?? "",
      t.tags.join(","),
      (t.depends_on ?? []).join(","),
    );
  }
  return parts.join(KEY_SEP);
}

function crewLayoutKey(view: ReadyViewDto): string {
  return [
    laneKey(view.working),
    laneKey(view.ready),
    laneKey(view.blocked.map((b) => b.task)),
    laneKey(view.paused),
    laneKey(view.done),
    laneKey(view.other),
  ].join(LANE_SEP);
}

export function CrewCanvas({
  view,
  selectedId,
  onSelect,
  proof = EMPTY_PROOF,
  onPlanOrder,
  ordering,
  boardSteps,
}: {
  view: ReadyViewDto;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Board-plan steps keyed by `board_task_id`, so a working node's story tells
   *  its real step instead of the generic "an agent is building this now". */
  boardSteps?: BoardStepsByTaskId;
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
  // Read through a ref so the layout memo can key on the fingerprint below
  // rather than the poll's throwaway object. Same string ⇒ same board, so
  // reusing the previous `view` to build it is sound.
  const viewRef = useRef(view);
  viewRef.current = view;
  const layoutKey = useMemo(() => crewLayoutKey(view), [view]);
  const layout = useMemo(
    () => computeCrewGraphLayout(viewRef.current, undefined, expanded, boardSteps),
    [layoutKey, expanded, boardSteps],
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
  // The card's click handler has to keep ONE identity for the whole life of
  // the canvas, or `CanvasNode`'s memo is worthless — the caller re-creates
  // `onSelect` on its own render cycle, so we route through a ref.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectNodeStable = useCallback(
    (id: string) => onSelectRef.current?.(id),
    [],
  );
  // Stay undefined when the caller wired no handler, so a read-only canvas
  // still renders cards with no click affordance, exactly as before.
  const selectNode = onSelect ? selectNodeStable : undefined;
  // Live size of the board viewport, so we can work out which cards actually
  // fall inside it. Tracked (not read ad-hoc) because the cull runs in render.
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const read = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  // Fit the graph into view — as much of it as stays readable. Called on
  // mount, on the "fit" button, and whenever the graph's size changes (a sync
  // added nodes). Whatever still overflows is centred if it fits on that axis
  // and pinned to the start if it doesn't, so a too-big graph opens on its
  // beginning rather than on its middle.
  const fitView = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.width === 0 || layout.height === 0) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const z = Math.max(
      READABLE_ZOOM,
      clampZoom(Math.min(vw / layout.width, vh / layout.height, 1) * 0.92),
    );
    const w = layout.width * z;
    const h = layout.height * z;
    setZoom(z);
    setPan({
      x: w <= vw ? (vw - w) / 2 : 16,
      y: h <= vh ? (vh - h) / 2 : 16,
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

  // The only thing the per-flow pass below reads off `view` is the done lane's
  // commit shas, so key it on those alone — otherwise a poll that changed
  // nothing still re-walked every region.
  const doneCommitsKey = useMemo(
    () => view.done.map((t) => `${t.id}:${t.commit_sha ?? ""}`).join(KEY_SEP),
    [view.done],
  );
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
    for (const t of viewRef.current.done)
      if (t.commit_sha) commitById.set(t.id, t.commit_sha);
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
  }, [layout.nodes, doneCommitsKey, proof]);

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

  // Only mount the cards inside (or just outside) the frame. A synced board
  // is 900+ nodes on a sheet many screens wide — mounting all of them cost a
  // wall of DOM that then re-rendered on every pointer move while panning.
  // Culling is invisible by construction: what we drop is off-screen anyway.
  const visibleNodes = useMemo(() => {
    if (viewport.w === 0 || viewport.h === 0) return layout.nodes;
    // Screen → board coordinates: the sheet is translated by `pan` then
    // scaled by `zoom` about its top-left.
    const left = -pan.x / zoom - CULL_MARGIN;
    const right = (viewport.w - pan.x) / zoom + CULL_MARGIN;
    const top = -pan.y / zoom - CULL_MARGIN;
    const bottom = (viewport.h - pan.y) / zoom + CULL_MARGIN;
    return layout.nodes.filter(
      (n) =>
        n.x + CREW_NODE_W >= left &&
        n.x <= right &&
        n.y + CREW_NODE_H >= top &&
        n.y <= bottom,
    );
  }, [layout.nodes, pan.x, pan.y, zoom, viewport.w, viewport.h]);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onWheel={onWheel}
      className="ui-crew-canvas"
      style={{
        cursor: drag.current ? "grabbing" : "grab",
        // The dotted board. Dots move + scale with the content so panning feels
        // like sliding an infinite sheet under the work.
        backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      {layout.nodes.length === 0 && layout.clusters.length === 0 ? (
        <CanvasEmpty />
      ) : (
        <div
          className="ui-crew-canvas-sheet"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {/* Edges, drawn first so node cards sit on top. */}
          <svg
            className="ui-crew-canvas-edges"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              {/* `context-stroke` makes the arrowhead inherit each edge's own
                  stroke — the selection colour on a picked edge, muted grey
                  otherwise — so it never falls back to SVG's default black. */}
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
              // Colour carries meaning: a selected chain takes the selection
              // colour; an arrow into a flow's last step is green ("leads to
              // the result"); a fan-out from one step into many takes that
              // step's hue so the parallel branches read as one family;
              // everything else is a plain grey sequential link.
              const restStroke = sinkIds.has(e.to)
                ? CREW_DONE_GREEN
                : (outDeg.get(e.from) ?? 0) >= 2
                  ? hueFor(e.from)
                  : CREW_EDGE_GREY;
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 6} ${y2}`}
                  fill="none"
                  stroke={active ? CREW_PICKED : restStroke}
                  // At rest the intra-zone links ARE the graph — bump them so the
                  // left→right dependency flow reads as the primary structure
                  // (they're all short + local, so density never becomes
                  // spaghetti). A selected chain still overpowers them.
                  strokeWidth={active ? 2.5 : 1.6}
                  strokeOpacity={active ? 1 : dimmed ? 0.1 : 0.5}
                  strokeDasharray={active ? "7 5" : undefined}
                  markerEnd="url(#crew-arrow)"
                  // Flowing dashes animate the direction of a selected chain —
                  // the path visibly streams from roots toward ends. Honours
                  // reduced motion (ui/crew-canvas.css).
                  className={active ? "ui-crew-edge-flow" : undefined}
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
                  stroke={CREW_REGION_THREAD}
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
                        stroke={CREW_PICKED}
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
                        stroke={CREW_DONE_GREEN}
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
                    className="ui-crew-wave"
                    style={{ left: c.x, top: gm.labelY, width: CREW_NODE_W }}
                  >
                    <span>Wave {c.col + 1}</span>
                    {c.count > 1 ? <small>· {c.count} in parallel</small> : null}
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
              className="ui-crew-order"
              style={{
                left: CREW_PAD,
                top: layout.gridStartY - 26,
                width: Math.max(layout.width - CREW_PAD * 2, CREW_NODE_W),
              }}
            >
              <span>
                No set order yet · {layout.freeCount}{" "}
                {layout.freeCount === 1 ? "task" : "tasks"}
              </span>
              <span className="ui-crew-order-rule" aria-hidden />
              {onPlanOrder ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={ordering ? undefined : onPlanOrder}
                  disabled={ordering}
                  title="Let the brain work out which of these must finish before which, and connect them"
                >
                  {ordering ? <AsciiSpinner size={11} /> : <Sparkles />}
                  {ordering ? "Working out the order…" : "Plan an order"}
                </Button>
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

          {visibleNodes.map((n) => (
            <CanvasNode
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              dimmed={hasSelection && !chain.nodes.has(n.id)}
              inChain={hasSelection && chain.nodes.has(n.id)}
              onSelect={selectNode}
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

      {/* Zoom controls — bottom-right, the node-editor convention. The same
          floating bar the code map uses; its scale doubles as "fit". */}
      {layout.nodes.length > 0 || layout.clusters.length > 0 ? (
        <div className="ui-graph-zoom ui-crew-zoom">
          <ZoomTool label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <Minus />
          </ZoomTool>
          <Button
            variant="ghost"
            size="xs"
            className="ui-graph-zoom-scale"
            onClick={fitView}
            title="Fit to view"
          >
            {Math.round(zoom * 100)}%
          </Button>
          <ZoomTool label="Zoom in" onClick={() => zoomBy(1.2)}>
            <Plus />
          </ZoomTool>
          <span className="ui-graph-zoom-rule" />
          <ZoomTool label="Fit to view" onClick={fitView}>
            <Maximize2 />
          </ZoomTool>
        </div>
      ) : null}
    </div>
  );
}

function ZoomTool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="iconXs"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

// A plan node's state → the board's lifecycle glyph, so a card here carries
// the same mark as the same task on the board and in its detail.
const NODE_STAGE: Record<WorkState, WorkspaceStage> = {
  queued: "backlog",
  ready: "backlog",
  working: "in-progress",
  blocked: "backlog",
  paused: "backlog",
  conflict: "canceled",
  done: "done",
  failed: "canceled",
  cancelled: "canceled",
};
// The two states that need someone keep the alarm colour on their glyph.
const NODE_ALARM: ReadonlySet<WorkState> = new Set(["conflict", "failed"]);

function NodeMark({ state }: { state: WorkState }) {
  return (
    <span
      className="ui-tasks-status-glyph"
      style={NODE_ALARM.has(state) ? { color: "var(--ui-red)" } : undefined}
      title={WORK_STATE[state].label}
    >
      <WorkspaceStageIcon stage={NODE_STAGE[state]} />
    </span>
  );
}

// Memoised on a plain shallow compare: the layout memo above hands out the
// same node objects until the work genuinely changes, and both handlers are
// identity-stable, so the only cards that re-render on a pan or a selection
// are the ones whose own state moved.
const CanvasNode = memo(function CanvasNode({
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
  const stateKey = nodeState(node.status);
  const state = WORK_STATE[stateKey];
  const done = node.status === "done";
  const working = node.status === "working";
  return (
    <button
      type="button"
      data-node
      onClick={onSelect ? () => onSelect(node.id) : undefined}
      // A node's hover card overflows its box; the card class lifts the
      // hovered node above its later-painted neighbours so they never clip it.
      className="ui-dashboard-card ui-tasks-card ui-crew-node"
      data-selected={selected || undefined}
      data-chain={inChain || undefined}
      data-dimmed={dimmed || undefined}
      data-done={done || undefined}
      style={{
        left: node.x,
        top: node.y,
        width: CREW_NODE_W,
        height: CREW_NODE_H,
      }}
    >
      {/* Title row — the agent avatar grounds it; the teammate who owns it (if
          any) rides alongside; the lifecycle glyph (or a spinner while an
          agent's on it) sits far-right. */}
      <div className="ui-crew-node-head">
        {canonical ? (
          <span className="ui-crew-node-agent">
            <AgentIcon
              agentId={canonical}
              label={agentDisplayLabel(canonical)}
              size={16}
            />
          </span>
        ) : (
          <span className="ui-crew-node-agent" data-empty title="No agent yet">
            ?
          </span>
        )}
        <strong className="ui-crew-node-title">{node.title}</strong>
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
              title="Watch this agent work. Open its live output"
              aria-label="Watch this agent work"
              className="ui-crew-node-watch"
            >
              {/* Spinner at rest, the watch glyph on card hover. */}
              <AsciiSpinner size={11} className="ui-crew-node-watch-rest" />
              <RadioTower className="ui-crew-node-watch-hover" />
            </span>
          ) : (
            <AsciiSpinner size={11} />
          )
        ) : (
          // A finished step reads as DONE at a glance — the board's filled
          // check, not a quiet dot you have to decode.
          <NodeMark state={stateKey} />
        )}
      </div>

      {/* The story — what this task is doing / waiting on / delivered, in plain
          words. This is the line that evolves as the work moves. */}
      <p className="ui-crew-node-story">{node.story}</p>

      {/* Hover card — a richer read without opening the detail: the full title,
          its state in words, who (robot + teammate) is on it, its priority, and
          where it sits in the flow. Sits below the card, doesn't catch the
          pointer, and only the hovered node's card lifts above its neighbours. */}
      <div className="ui-crew-node-card" aria-hidden>
        <strong>{node.title}</strong>
        <TaskStatusBadge
          stage={NODE_STAGE[stateKey]}
          label={state.hint}
          color={NODE_ALARM.has(stateKey) ? "var(--ui-red)" : undefined}
        />
        <div className="ui-crew-node-card-facts">
          <TaskFact
            icon={
              canonical ? (
                <AgentIcon
                  agentId={canonical}
                  label={agentDisplayLabel(canonical)}
                  size={13}
                />
              ) : undefined
            }
          >
            {canonical ? agentDisplayLabel(canonical) : "No agent yet"}
          </TaskFact>
          {node.assignee ? (
            <TaskFact icon={<AssigneeBit name={node.assignee} size={13} />}>
              {node.assignee}
            </TaskFact>
          ) : null}
          {node.priority && node.priority !== "low" ? (
            <TaskFact>
              <span className="ui-crew-node-priority">{node.priority} priority</span>
            </TaskFact>
          ) : null}
        </div>
        {node.waitingCount > 0 || node.unblockCount > 0 ? (
          <p>
            {node.waitingCount > 0 ? `Waiting on ${node.waitingCount}` : ""}
            {node.waitingCount > 0 && node.unblockCount > 0 ? " · " : ""}
            {node.unblockCount > 0 ? `Unblocks ${node.unblockCount}` : ""}
          </p>
        ) : null}
        {node.story ? <p className="ui-crew-node-card-story">{node.story}</p> : null}
      </div>
    </button>
  );
});

// Who's on it + a quiet progress bar — the shape of a group at a glance,
// reused by goal regions, objective sections and work groups so every header
// reads the same.
function RollupChips({ stat }: { stat: CrewClusterStat }) {
  const pct = percent(stat.done, stat.total);
  return (
    <div className="ui-crew-rollup">
      {stat.agentKinds.slice(0, 3).map((ak) => {
        const c = canonicalAgentId(ak);
        return (
          <AgentIcon key={ak} agentId={c} label={agentDisplayLabel(c)} size={14} />
        );
      })}
      {stat.assignees.length > 0 ? (
        <TaskFact icon={<Users />}>{stat.assignees.length}</TaskFact>
      ) : null}
      <Progress
        value={pct}
        className="ui-crew-rollup-bar"
        data-tone="done"
        title={`${pct}% done`}
      />
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
      className="ui-crew-objective"
      style={{
        left: objective.x,
        top: objective.y,
        width: objective.width,
      }}
    >
      <div
        className="ui-crew-objective-head"
        style={{ height: objective.headerHeight }}
      >
        <span className="ui-crew-tile" data-tone="goal">
          <Flag />
        </span>
        <div className="ui-crew-objective-name">
          <small>Objective</small>
          <strong>{objective.title}</strong>
        </div>
        <span className="ui-crew-objective-meta">
          {objective.regionCount}{" "}
          {objective.regionCount === 1 ? "goal" : "goals"} · {stat.total}{" "}
          {stat.total === 1 ? "step" : "steps"}
          {stat.done > 0 ? ` · ${stat.done} done` : ""}
        </span>
        <RollupChips stat={stat} />
      </div>
      {/* The only line — a faint full-width rule that says "this objective's
          goals start here", without a box wrapping them. */}
      <div className="ui-crew-objective-rule" />
    </div>
  );
}

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
      className="ui-crew-bookend ui-crew-goal"
      style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
    >
      <div className="ui-crew-bookend-head">
        <Flag />
        <span>Goal</span>
        {/* Who'll work it — the robots this flow's steps are handed to. */}
        {stat.agentKinds.length > 0 ? (
          <span className="ui-crew-bookend-agents">
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
      <strong className="ui-crew-bookend-title">{region.title}</strong>
      <small className="ui-crew-bookend-foot">
        {stat.total} {stat.total === 1 ? "step" : "steps"}
        {waves > 1 ? ` · ${waves} waves` : ""}
      </small>
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
  const pct = percent(stat.done, stat.total);
  const complete = stat.total > 0 && stat.done === stat.total;
  const allProven = complete && proven === stat.done;
  return (
    <div
      data-node
      className="ui-crew-bookend ui-crew-result"
      data-proven={allProven || undefined}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
    >
      <div className="ui-crew-bookend-head">
        <CheckCircle2 />
        <span>Result</span>
        <strong className="ui-crew-result-pct">{pct}%</strong>
      </div>
      <Progress
        value={pct}
        className="ui-crew-result-bar"
        data-tone={allProven ? "done" : undefined}
      />
      <small className="ui-crew-bookend-foot">
        {allProven ? (
          <span className="ui-crew-result-proven">
            Delivered &amp; proven · {proven}/{stat.total} checks
          </span>
        ) : (
          <>
            {stat.done}/{stat.total} done
            {proven > 0 ? ` · ${proven} proven` : ""}
            {stat.done === 0 ? " · not started" : ""}
          </>
        )}
      </small>
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
  const kindLabel =
    cluster.kind === "epic"
      ? "Epic"
      : cluster.kind === "sprint"
        ? "Sprint"
        : cluster.kind === "crew"
          ? "Crew"
          : "Loose tasks";
  return (
    <div
      data-node
      className="ui-crew-cluster"
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
        className="ui-crew-cluster-head"
        style={{ height: CREW_CLUSTER_HEADER_H }}
        aria-expanded={cluster.expanded}
        title={cluster.expanded ? "Collapse this group" : "Open this group"}
      >
        {cluster.expanded ? (
          <ChevronDown className="ui-crew-cluster-chevron" />
        ) : (
          <ChevronRight className="ui-crew-cluster-chevron" />
        )}
        <span className="ui-crew-tile">
          <Layers />
        </span>
        <div className="ui-crew-cluster-name">
          <div>
            <strong>{cluster.title}</strong>
            <Badge variant="secondary">{kindLabel}</Badge>
          </div>
          <small>
            {stat.total} {stat.total === 1 ? "task" : "tasks"}
            {stat.attention > 0 ? ` · ${stat.attention} need attention` : ""}
            {stat.done > 0 ? ` · ${stat.done} done` : ""}
            {stat.working > 0 ? ` · ${stat.working} in progress` : ""}
          </small>
        </div>
        {/* Who's on it + a quiet progress bar — the shape of the group at a
            glance, without opening it. */}
        <RollupChips stat={stat} />
      </button>
    </div>
  );
}

function CanvasEmpty() {
  return <EmptyState icon={Network} title="Nothing to plot yet." size="sm" />;
}
