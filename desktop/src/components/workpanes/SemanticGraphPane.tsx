// Live Semantic Graph (graphify port) — physics-based, pannable, zoomable.
//
// Renders the project knowledge graph from `.aura/kg/graph.json` (built
// by `aura_kg_build`) as a force-directed SVG with d3-force underneath:
//
//   • Continuous rAF tick loop with alpha decay (Verlet-style)
//   • Barnes-Hut O(N log N) repulsion via d3-quadtree
//   • Pan: drag empty space. Zoom: mousewheel (focal-point at cursor).
//   • Drag a node to pin it (fx/fy). Double-click a pinned node to free.
//   • Hover highlights direct neighbours; non-neighbours fade to 0.08.
//   • God nodes carry a soft amber glow + label always-on.
//   • Surprise edges drawn brighter and thicker.
//
// Time scrubber lives at the bottom — currently a single-frame stub
// (Phase 2 lands the `aura_kg_timeline` backend that produces commit
// deltas). The bar is visible so the layout is final before the data
// path arrives.
//
// Wrapped in `GraphErrorBoundary` so a malformed payload or NaN-poisoned
// position doesn't kill the whole shell. Native panics are still caught
// by `crash.rs` on the Rust side.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  Crosshair,
  Maximize2,
  Minus,
  PinOff,
  Plus,
  RefreshCcw,
  RotateCcw,
  X,
} from "lucide-react";
import { api, type KgGraph, type KgNode, type KgEdge } from "../../lib/api";
import { Button } from "../ui/button";
import { GraphErrorBoundary } from "./GraphErrorBoundary";

type Props = { repoRoot: string; onClose: () => void };

type SimNode = SimulationNodeDatum & {
  id: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  degree: number;
  community_id: number;
  god: boolean;
};

type SimLink = SimulationLinkDatum<SimNode> & {
  kind: string;
  surprise: boolean;
};

type SelectedLink = {
  edge: KgEdge;
  other: KgNode;
  direction: "in" | "out";
};

const NODE_CAP = 800;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 6;
const HOLO = {
  base: "var(--color-text-3, #8a8f98)",
  bright: "var(--color-text-1, #f3f4f6)",
  hot: "var(--color-text-1, #f3f4f6)",
  tool: "#c28f2c",
  success: "#5d9a72",
  dispatch: "#8b7ab8",
  surprise: "#d39b37",
  panel: "color-mix(in oklab, var(--color-bg-1, #111) 88%, transparent)",
  panelStrong: "var(--color-bg-1, #111)",
  border: "var(--color-line-soft, rgba(255,255,255,0.10))",
  borderStrong: "var(--color-line, rgba(255,255,255,0.18))",
  muted: "var(--color-text-4, #6b7280)",
};

export function SemanticGraphPane(props: Props) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <GraphErrorBoundary onRetry={() => setResetKey((k) => k + 1)}>
      <SemanticGraphInner key={resetKey} {...props} />
    </GraphErrorBoundary>
  );
}

function SemanticGraphInner({ repoRoot, onClose }: Props) {
  const [graph, setGraph] = useState<KgGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [includeDocs, setIncludeDocs] = useState(false);
  const [kindFilter, setKindFilter] = useState<Set<string>>(
    new Set(["fn", "class", "type", "file"]),
  );
  const [communityFilter, setCommunityFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitSelectionSignal, setFitSelectionSignal] = useState(0);

  const refresh = useCallback(
    async (force: boolean) => {
      setErr(null);
      try {
        if (force) {
          setBuilding(true);
          const g = await api.auraKgBuild(repoRoot, true);
          setGraph(g);
        } else {
          setLoading(true);
          const cached = await api.auraKgLoad(repoRoot);
          if (cached) {
            setGraph(cached);
          } else {
            setBuilding(true);
            const g = await api.auraKgBuild(repoRoot, false);
            setGraph(g);
          }
        }
      } catch (e) {
        setErr(String(e));
      } finally {
        setLoading(false);
        setBuilding(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!graph) return null;
    const q = search.trim().toLowerCase();
    const allowedDocs = includeDocs
      ? new Set(["doc", "section"])
      : new Set<string>();
    let visibleNodes = graph.nodes.filter((n) => {
      if (n.kind === "doc" || n.kind === "section") {
        if (!allowedDocs.has(n.kind)) return false;
      } else if (!kindFilter.has(n.kind)) {
        return false;
      }
      if (communityFilter !== null && n.community_id !== communityFilter)
        return false;
      if (
        q &&
        !n.name.toLowerCase().includes(q) &&
        !n.file.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    let truncated = false;
    if (visibleNodes.length > NODE_CAP) {
      // Keep highest-degree nodes — they're the most informative anchor
      // points; user can subset via filters to see the rest.
      visibleNodes = [...visibleNodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, NODE_CAP);
      truncated = true;
    }
    const ids = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = graph.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to),
    );
    return { nodes: visibleNodes, edges: visibleEdges, truncated };
  }, [graph, includeDocs, kindFilter, communityFilter, search]);

  const gods = useMemo(() => {
    if (!graph) return [];
    return [...graph.nodes]
      .filter((n) => n.god)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 10);
  }, [graph]);

  const surprises = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter((e) => e.surprise).slice(0, 10);
  }, [graph]);

  const graphNodeById = useMemo(() => {
    return new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const));
  }, [graph]);

  const selectedNode = selectedId ? graphNodeById.get(selectedId) ?? null : null;

  const selectedLinks = useMemo<SelectedLink[]>(() => {
    if (!graph || !selectedId) return [];
    return graph.edges
      .map((edge) => {
        if (edge.from !== selectedId && edge.to !== selectedId) return null;
        const isOut = edge.from === selectedId;
        const other = graphNodeById.get(isOut ? edge.to : edge.from);
        if (!other) return null;
        return {
          edge,
          other,
          direction: isOut ? "out" : "in",
        } satisfies SelectedLink;
      })
      .filter((x): x is SelectedLink => Boolean(x))
      .sort((a, b) => {
        if (a.edge.surprise !== b.edge.surprise) {
          return a.edge.surprise ? -1 : 1;
        }
        return b.other.degree - a.other.degree;
      })
      .slice(0, 12);
  }, [graph, graphNodeById, selectedId]);

  const selectNode = useCallback(
    (id: string, opts?: { fit?: boolean }) => {
      setSelectedId(id);
      if (opts?.fit) setFitSelectionSignal((n) => (n + 1) & 0xffff);
      const n = graph?.nodes.find((x) => x.id === id);
      if (!n) return;
      window.dispatchEvent(
        new CustomEvent("aura:open-file", {
          detail: { path: n.file, line: n.line > 0 ? n.line : undefined },
        }),
      );
    },
    [graph],
  );

  const focusNode = useCallback(
    (id: string) => selectNode(id, { fit: true }),
    [selectNode],
  );

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <header className="h-9 flex items-center px-4 border-b border-line-soft flex-shrink-0 gap-3">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Code Map
        </span>
        {graph && (
          <span className="text-text-4 text-[10.5px] tabular-nums">
            {graph.stats.symbols} pieces · {graph.stats.files} files ·{" "}
            {graph.stats.communities} clusters · {graph.stats.gods} hubs ·{" "}
            {graph.stats.surprises} unexpected links
            {filtered?.truncated &&
              ` · showing top ${NODE_CAP} (filter to see more)`}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => refresh(true)}
          disabled={building}
        >
          {building ? "rebuilding…" : "Rebuild"}
        </Button>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="ml-auto w-6 h-6 rounded text-text-4 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center"
        >
          ×
        </button>
      </header>

      {err && (
        <div className="text-red-400 text-[11px] font-mono px-4 py-2 border-b border-line-soft">
          {err}
        </div>
      )}

      <div className="flex-shrink-0 border-b border-line-soft px-3 py-2 flex items-center gap-2 flex-wrap text-[11px]">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search for a piece or file…"
          className="bg-bg-1 border border-line-soft rounded px-2 py-1 text-[11px] text-text-1 outline-none focus:border-text-4 w-56"
        />
        <KindFilter
          cur={kindFilter}
          onToggle={(k) => {
            const next = new Set(kindFilter);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            setKindFilter(next);
          }}
        />
        <label className="flex items-center gap-1.5 text-text-3 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={includeDocs}
            onChange={(e) => setIncludeDocs(e.target.checked)}
          />
          include docs
        </label>
        {graph && graph.stats.communities > 1 && (
          <CommunityFilter
            current={communityFilter}
            count={graph.stats.communities}
            onPick={setCommunityFilter}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-hidden bg-bg-1 relative">
          {loading || building ? (
            <div className="absolute inset-0 flex items-center justify-center text-text-4 text-[12px]">
              {building ? "building graph…" : "loading…"}
            </div>
          ) : filtered ? (
            <GraphCanvas
              nodes={filtered.nodes}
              edges={filtered.edges}
              hoverId={hoverId}
              selectedId={selectedId}
              fitSelectionSignal={fitSelectionSignal}
              onHover={setHoverId}
              onSelect={selectNode}
              onClearSelection={() => setSelectedId(null)}
            />
          ) : null}
        </div>
        <aside className="w-72 border-l border-line-soft flex flex-col">
          <SelectionPanel
            node={selectedNode}
            links={selectedLinks}
            onPick={focusNode}
            onFocus={() => {
              if (selectedNode) focusNode(selectedNode.id);
            }}
            onClear={() => setSelectedId(null)}
          />
          <SidePanel
            label="Hubs"
            nodes={gods}
            onPick={focusNode}
            empty="No hubs here yet — not enough connections to form one."
          />
          <SurprisesPanel
            edges={surprises}
            allNodes={graph?.nodes ?? []}
            onPick={focusNode}
          />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GraphCanvas — owns the d3-force simulation, pan/zoom/drag interactions.
// ---------------------------------------------------------------------------

function GraphCanvas({
  nodes,
  edges,
  hoverId,
  selectedId,
  fitSelectionSignal,
  onHover,
  onSelect,
  onClearSelection,
}: {
  nodes: KgNode[];
  edges: KgEdge[];
  hoverId: string | null;
  selectedId: string | null;
  fitSelectionSignal: number;
  onHover: (id: string | null) => void;
  onSelect: (id: string, opts?: { fit?: boolean }) => void;
  onClearSelection: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [, forceTick] = useState(0);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  // Track sim node objects in a ref so React state changes don't recreate
  // the simulation on every render. The sim is the source of truth for
  // x/y positions; we just trigger re-renders on rAF tick.
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  const nodeById = useMemo(() => {
    return new Map(nodes.map((n) => [n.id, n] as const));
  }, [nodes]);

  // ResizeObserver — fill the parent container, react to layout shifts.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const parent = svg.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) {
          setSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // Build / rebuild the simulation when the input set changes. Carry over
  // existing positions for nodes that survived the filter so the layout
  // doesn't blink to a new arrangement on every keystroke.
  useEffect(() => {
    const prev = simNodesRef.current;
    const cx = size.w / 2;
    const cy = size.h / 2;
    const next = new Map<string, SimNode>();
    nodes.forEach((n, i) => {
      const carry = prev.get(n.id);
      if (carry) {
        next.set(n.id, {
          ...carry,
          kind: n.kind,
          name: n.name,
          file: n.file,
          line: n.line,
          degree: n.degree,
          community_id: n.community_id,
          god: n.god,
        });
      } else {
        // Seed new nodes near the centre on a small ring so the sim
        // doesn't have to push them out of a singularity.
        const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        const r = Math.min(size.w, size.h) * 0.2;
        next.set(n.id, {
          id: n.id,
          kind: n.kind,
          name: n.name,
          file: n.file,
          line: n.line,
          degree: n.degree,
          community_id: n.community_id,
          god: n.god,
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
        });
      }
    });
    simNodesRef.current = next;

    const simNodes = Array.from(next.values());
    const simLinks: SimLink[] = edges
      .filter((e) => next.has(e.from) && next.has(e.to))
      .map((e) => ({
        source: next.get(e.from)!,
        target: next.get(e.to)!,
        kind: e.kind,
        surprise: e.surprise,
      }));

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((n) => n.id)
          .distance(60)
          .strength(0.4),
      )
      .force(
        "charge",
        forceManyBody<SimNode>()
          .strength((n) => -120 - (n.god ? 200 : 0) - n.degree * 4)
          .distanceMax(420),
      )
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((n) => nodeVisualRadius(n) + 22)
          .strength(0.42)
          .iterations(1),
      )
      .force("center", forceCenter(cx, cy).strength(0.04))
      .force("x", forceX(cx).strength(0.02))
      .force("y", forceY(cy).strength(0.02))
      .alpha(1)
      .alphaDecay(0.025)
      .velocityDecay(0.3);

    sim.on("tick", () => {
      forceTick((t) => (t + 1) & 0xffff);
    });

    simRef.current?.stop();
    simRef.current = sim;

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, size.w, size.h]);

  // Reapply pinning whenever the set changes. fx/fy in d3-force pin a
  // node in place; clearing them lets the sim move it again.
  useEffect(() => {
    for (const [id, sn] of simNodesRef.current) {
      if (pinned.has(id)) {
        if (sn.fx == null) sn.fx = sn.x ?? 0;
        if (sn.fy == null) sn.fy = sn.y ?? 0;
      } else {
        sn.fx = null;
        sn.fy = null;
      }
    }
    simRef.current?.alpha(0.4).restart();
  }, [pinned]);

  // ---------- Pan / Zoom ----------

  function clientToWorld(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const t = transformRef.current;
    return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
  }

  const zoomBy = useCallback(
    (factor: number) => {
      const t = transformRef.current;
      const nextK = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, t.k * factor));
      if (nextK === t.k) return;
      const sx = size.w / 2;
      const sy = size.h / 2;
      setTransform({
        x: sx - ((sx - t.x) * nextK) / t.k,
        y: sy - ((sy - t.y) * nextK) / t.k,
        k: nextK,
      });
    },
    [size.h, size.w],
  );

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const t = transformRef.current;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextK = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, t.k * factor));
    if (nextK === t.k) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Keep the world-point under the cursor stationary across the scale
    // change: solve nextX such that (sx - nextX) / nextK = (sx - t.x) / t.k.
    const nextX = sx - ((sx - t.x) * nextK) / t.k;
    const nextY = sy - ((sy - t.y) * nextK) / t.k;
    setTransform({ x: nextX, y: nextY, k: nextK });
  }

  // Pan + node-drag share pointer events. We resolve which one is in
  // play via the `dragging` ref shape.
  type DragState =
    | { kind: "pan"; startX: number; startY: number; tx: number; ty: number }
    | { kind: "node"; id: string; pointerId: number };
  const dragRef = useRef<DragState | null>(null);

  function onPointerDownBackground(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-node-id]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = transformRef.current;
    dragRef.current = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      tx: t.x,
      ty: t.y,
    };
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") {
      setTransform({
        x: d.tx + (e.clientX - d.startX),
        y: d.ty + (e.clientY - d.startY),
        k: transformRef.current.k,
      });
    } else {
      const sn = simNodesRef.current.get(d.id);
      if (!sn) return;
      const w = clientToWorld(e.clientX, e.clientY);
      sn.fx = w.x;
      sn.fy = w.y;
      simRef.current?.alpha(0.3).restart();
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (d.kind === "node") {
      // Drag-released node stays pinned. Double-click to free.
      setPinned((prev) => {
        const next = new Set(prev);
        next.add(d.id);
        return next;
      });
    }
  }

  function onNodePointerDown(e: React.PointerEvent<SVGElement>, id: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const svg = svgRef.current!;
    svg.setPointerCapture(e.pointerId);
    dragRef.current = { kind: "node", id, pointerId: e.pointerId };
    const sn = simNodesRef.current.get(id);
    if (sn) {
      sn.fx = sn.x ?? 0;
      sn.fy = sn.y ?? 0;
    }
    simRef.current?.alphaTarget(0.2).restart();
  }

  function onNodeDoubleClick(id: string) {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      return next;
    });
    onSelect(id);
  }

  function onBackgroundDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if ((e.target as Element).closest("[data-node-id]")) return;
    e.preventDefault();
    fitGraph();
  }

  const resetView = useCallback(() => {
    setTransform({ x: 0, y: 0, k: 1 });
  }, []);

  const reheat = useCallback(() => {
    simRef.current?.alpha(0.8).restart();
  }, []);

  const fitNodeIds = useCallback(
    (ids: Set<string> | null, maxScale: number) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [id, sn] of simNodesRef.current) {
        if (ids && !ids.has(id)) continue;
        if (sn.x == null || sn.y == null) continue;
        const node = nodeById.get(id);
        const r = node ? nodeVisualRadius(node) + 22 : 34;
        minX = Math.min(minX, sn.x - r);
        maxX = Math.max(maxX, sn.x + r);
        minY = Math.min(minY, sn.y - r);
        maxY = Math.max(maxY, sn.y + r);
      }
      if (minX === Infinity) return false;
      const padding = 96;
      const boundsW = Math.max(160, maxX - minX) + padding * 2;
      const boundsH = Math.max(160, maxY - minY) + padding * 2;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const k = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, maxScale, size.w / boundsW, size.h / boundsH),
      );
      setTransform({
        x: size.w / 2 - centerX * k,
        y: size.h / 2 - centerY * k,
        k,
      });
      return true;
    },
    [nodeById, size.h, size.w],
  );

  const fitGraph = useCallback(() => {
    if (!fitNodeIds(null, 1.6)) resetView();
  }, [fitNodeIds, resetView]);

  const selectedScope = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.from === selectedId) ids.add(e.to);
      else if (e.to === selectedId) ids.add(e.from);
    }
    return ids;
  }, [edges, selectedId]);

  const fitSelected = useCallback(() => {
    if (selectedScope && fitNodeIds(selectedScope, 2.4)) return;
    fitGraph();
  }, [fitGraph, fitNodeIds, selectedScope]);

  useEffect(() => {
    if (fitSelectionSignal > 0) fitSelected();
  }, [fitSelectionSignal, fitSelected]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        fitGraph();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        fitSelected();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(1.18);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomBy(1 / 1.18);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        reheat();
      } else if (e.key === "Escape") {
        onHover(null);
        onClearSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    fitGraph,
    fitSelected,
    onClearSelection,
    onHover,
    reheat,
    zoomBy,
  ]);

  // ---------- Highlight neighbours ----------

  const focusId = hoverId ?? selectedId;
  const neighbourSet = useMemo(() => {
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    for (const e of edges) {
      if (e.from === focusId) set.add(e.to);
      else if (e.to === focusId) set.add(e.from);
    }
    return set;
  }, [focusId, edges]);

  const t = transform;
  const transformAttr = `translate(${t.x} ${t.y}) scale(${t.k})`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg-1">
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: "none", cursor: "grab" }}
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        onWheel={onWheel}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onBackgroundDoubleClick}
      >
        <defs>
          <pattern
            id="dot-grid"
            x="0"
            y="0"
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx="1"
              cy="1"
              r="0.65"
              fill="var(--color-line-soft, rgba(255,255,255,0.10))"
            />
          </pattern>
          <marker
            id="arrow"
            viewBox="0 -3 6 6"
            refX="6"
            refY="0"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path
              d="M0,-3 L6,0 L0,3"
              fill={HOLO.muted}
            />
          </marker>
          <marker
            id="arrow-surprise"
            viewBox="0 -3 6 6"
            refX="6"
            refY="0"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,-3 L6,0 L0,3" fill="#fbbf24" />
          </marker>
          <filter id="god-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width={size.w} height={size.h} fill="var(--color-bg-1, #111)" />
        <rect width={size.w} height={size.h} fill="url(#dot-grid)" opacity={0.45} />

        <g transform={transformAttr}>
          <g pointerEvents="none">
            {edges.map((e, i) => {
              const a = simNodesRef.current.get(e.from);
              const b = simNodesRef.current.get(e.to);
              if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null)
                return null;
              const inFocus =
                !neighbourSet ||
                (neighbourSet.has(e.from) && neighbourSet.has(e.to));
              const opacity = inFocus ? (e.surprise ? 0.72 : 0.34) : 0.045;
              const stroke = relationColor(e);
              const sw = (e.surprise ? 1.35 : 0.85) / Math.sqrt(t.k);
              const geom = edgeGeometry(a.x, a.y, b.x, b.y, i);
              return (
                <g key={`${e.from}-${e.to}-${i}`}>
                  <path
                    d={geom.d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={sw}
                    opacity={opacity}
                    strokeLinecap="round"
                    markerEnd={
                      e.surprise ? "url(#arrow-surprise)" : "url(#arrow)"
                    }
                  />
                  {e.surprise && inFocus && (
                    <path
                      d={geom.d}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={Math.max(0.5, sw * 0.5)}
                      strokeLinecap="round"
                      strokeDasharray="3 7"
                      opacity={0.42}
                    >
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-20"
                        dur="2.4s"
                        repeatCount="indefinite"
                      />
                    </path>
                  )}
                </g>
              );
            })}
          </g>
          <g>
            {nodes.map((n) => {
              const sn = simNodesRef.current.get(n.id);
              if (!sn || sn.x == null || sn.y == null) return null;
              const r = nodeVisualRadius(n);
              const fill = nodeColor(n);
              const isHover = hoverId === n.id;
              const isSel = selectedId === n.id;
              const isPinned = pinned.has(n.id);
              const inFocus = !neighbourSet || neighbourSet.has(n.id);
              const opacity = inFocus ? 1 : 0.12;
              const showLabel = n.god || isHover || isSel || n.degree > 18;
              const label = truncateLabel(n.name, isSel || isHover ? 30 : 20);
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  transform={`translate(${sn.x} ${sn.y})`}
                  opacity={opacity}
                  onPointerDown={(e) => onNodePointerDown(e, n.id)}
                  onMouseEnter={() => onHover(n.id)}
                  onMouseLeave={() => onHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(n.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onNodeDoubleClick(n.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {(isSel || n.god) && (
                    <circle
                      r={r + 4}
                      fill="none"
                      stroke={n.god ? HOLO.surprise : HOLO.bright}
                      strokeWidth={isSel ? 1.4 : 0.9}
                      opacity={isSel ? 0.75 : 0.45}
                      filter={n.god ? "url(#god-glow)" : undefined}
                    />
                  )}
                  <circle
                    r={r}
                    fill={fill}
                    fillOpacity={n.god ? 0.22 : 0.16}
                    stroke={
                      isSel
                        ? HOLO.hot
                        : n.god
                          ? HOLO.surprise
                          : isHover
                            ? HOLO.bright
                            : fill
                    }
                    strokeWidth={isSel ? 1.8 : n.god ? 1.35 : isHover ? 1.25 : 0.8}
                  />
                  <text
                    y={3}
                    fontSize={7.5}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    fontWeight={700}
                    textAnchor="middle"
                    fill={isSel ? HOLO.hot : HOLO.muted}
                    pointerEvents="none"
                  >
                    {nodeGlyph(n.kind)}
                  </text>
                  {isPinned && (
                    <circle
                      r={r + 2.5}
                      fill="none"
                      stroke={HOLO.hot}
                      strokeWidth={0.65}
                      strokeDasharray="2 2"
                      opacity={0.5}
                    />
                  )}
                  {showLabel && (
                    <g pointerEvents="none">
                      <text
                        y={r + 12}
                        fontSize={10}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        textAnchor="middle"
                        fill={isSel || isHover ? HOLO.bright : HOLO.muted}
                        stroke="var(--color-bg-1, #111)"
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {label}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <CanvasOverlay
        scale={t.k}
        pinnedCount={pinned.size}
        onReset={resetView}
        onFit={fitGraph}
        onFitSelected={selectedId ? fitSelected : undefined}
        onZoomIn={() => zoomBy(1.18)}
        onZoomOut={() => zoomBy(1 / 1.18)}
        onReheat={reheat}
        onUnpinAll={() => setPinned(new Set())}
      />
    </div>
  );
}

function CanvasOverlay({
  scale,
  pinnedCount,
  onReset,
  onFit,
  onFitSelected,
  onZoomIn,
  onZoomOut,
  onReheat,
  onUnpinAll,
}: {
  scale: number;
  pinnedCount: number;
  onReset: () => void;
  onFit: () => void;
  onFitSelected?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReheat: () => void;
  onUnpinAll: () => void;
}) {
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-1 text-[10.5px] text-text-3 bg-bg-1/85 backdrop-blur-sm border border-line-soft rounded px-1.5 py-1 pointer-events-auto shadow-sm">
      <span className="tabular-nums min-w-9 text-center">
        {Math.round(scale * 100)}%
      </span>
      <IconButton title="Zoom out" onClick={onZoomOut}>
        <Minus className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton title="Zoom in" onClick={onZoomIn}>
        <Plus className="w-3.5 h-3.5" />
      </IconButton>
      <Divider />
      <IconButton title="Fit graph" onClick={onFit}>
        <Maximize2 className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton title="Fit selection" onClick={onFitSelected} disabled={!onFitSelected}>
        <Crosshair className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton title="Reset pan and zoom" onClick={onReset}>
        <RotateCcw className="w-3.5 h-3.5" />
      </IconButton>
      <Divider />
      <IconButton title="Restart layout" onClick={onReheat}>
        <RefreshCcw className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton
        title="Unpin all pieces"
        onClick={onUnpinAll}
        disabled={pinnedCount === 0}
      >
        <PinOff className="w-3.5 h-3.5" />
      </IconButton>
      {pinnedCount > 0 && (
        <span className="tabular-nums text-text-4 px-1">{pinnedCount}</span>
      )}
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || !onClick}
      onClick={onClick}
      className="w-6 h-6 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-3"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="w-px h-4 bg-line-soft mx-0.5" />;
}

// ---------------------------------------------------------------------------
// Side panels (gods + surprises) — minor visual tightening only.
// ---------------------------------------------------------------------------

function SelectionPanel({
  node,
  links,
  onPick,
  onFocus,
  onClear,
}: {
  node: KgNode | null;
  links: SelectedLink[];
  onPick: (id: string) => void;
  onFocus: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex-shrink-0 max-h-[46%] flex flex-col border-b border-line-soft">
      <div className="text-text-4 text-[10px] uppercase tracking-wider px-3 py-1.5 border-b border-line-soft flex items-center gap-2">
        <span className="flex-1">Selection</span>
        <IconButton title="Fit selection" onClick={node ? onFocus : undefined} disabled={!node}>
          <Crosshair className="w-3.5 h-3.5" />
        </IconButton>
        <IconButton title="Clear selection" onClick={node ? onClear : undefined} disabled={!node}>
          <X className="w-3.5 h-3.5" />
        </IconButton>
      </div>
      {!node ? (
        <div className="text-text-4 text-[11px] px-3 py-2">Nothing selected — click a piece to see what it connects to.</div>
      ) : (
        <>
          <div className="px-3 py-2 border-b border-line-soft">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: communityColor(node.community_id) }}
                title="Colour groups pieces that work closely together"
              />
              <div className="text-text-1 text-[12px] font-medium truncate" title={node.name}>
                {node.name}
              </div>
            </div>
            <div className="text-text-4 text-[10px] truncate mt-1" title={node.file}>
              {node.kind} · {compactPath(node.file, node.line)}
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-[10px]">
              <span title="How many other pieces connect to this one">
                <Badge>{node.degree} {node.degree === 1 ? "link" : "links"}</Badge>
              </span>
              {node.god && (
                <span title="A hub — lots of other pieces depend on this one, so changes here ripple wide">
                  <Badge tone="gold">hub</Badge>
                </span>
              )}
            </div>
          </div>
          <div className="overflow-y-auto min-h-0">
            {links.length === 0 ? (
              <div className="text-text-4 text-[11px] px-3 py-2">
                Nothing connects to this piece.
              </div>
            ) : (
              links.map(({ edge, other, direction }, i) => (
                <button
                  key={`${edge.from}-${edge.to}-${i}`}
                  type="button"
                  onClick={() => onPick(other.id)}
                  className="w-full text-left px-3 py-1.5 hover:bg-bg-2 border-b border-line-soft last:border-b-0"
                  title={`${edge.kind} ${direction === "out" ? "to" : "from"} ${other.id}`}
                >
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="text-text-4">{direction === "out" ? "->" : "<-"}</span>
                    <span className="text-text-1 truncate flex-1">{other.name}</span>
                    {edge.surprise && (
                      <span className="text-amber-400 text-[10px]" title="An unexpected link — these two pieces sit in different clusters but still depend on each other">unexpected</span>
                    )}
                  </div>
                  <div className="text-text-4 text-[10px] truncate">
                    {edge.kind} · {other.kind} · {compactPath(other.file, other.line)}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "gold";
}) {
  return (
    <span
      className={[
        "px-1.5 py-0.5 rounded border tabular-nums",
        tone === "gold"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-line-soft bg-bg-2 text-text-3",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function KindFilter({
  cur,
  onToggle,
}: {
  cur: Set<string>;
  onToggle: (k: string) => void;
}) {
  const kinds: Array<[string, string]> = [
    ["file", "files"],
    ["fn", "fns"],
    ["class", "classes"],
    ["type", "types"],
  ];
  return (
    <div className="flex items-center gap-1">
      {kinds.map(([k, label]) => {
        const active = cur.has(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            className={[
              "px-1.5 py-0.5 text-[10.5px] rounded border",
              active
                ? "bg-bg-3 border-line text-text-1"
                : "bg-bg-1 border-line-soft text-text-4 hover:bg-bg-2",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function CommunityFilter({
  current,
  count,
  onPick,
}: {
  current: number | null;
  count: number;
  onPick: (c: number | null) => void;
}) {
  return (
    <select
      value={current ?? ""}
      onChange={(e) =>
        onPick(e.target.value === "" ? null : parseInt(e.target.value, 10))
      }
      className="bg-bg-1 border border-line-soft rounded px-1.5 py-0.5 text-[10.5px] text-text-1 outline-none focus:border-text-4"
    >
      <option value="">all clusters ({count})</option>
      {Array.from({ length: count }).map((_, i) => (
        <option key={i} value={i}>
          cluster {i}
        </option>
      ))}
    </select>
  );
}

function nodeVisualRadius(n: Pick<KgNode, "kind" | "degree" | "god">): number {
  const base =
    n.kind === "file" ? 5.5 : n.kind === "class" ? 7 : n.kind === "type" ? 6.5 : 6;
  const bonus = Math.min(6, Math.sqrt(Math.max(0, n.degree)));
  return base + bonus + (n.god ? 3 : 0);
}

function nodeColor(n: Pick<KgNode, "kind" | "community_id" | "god">): string {
  if (n.god) return HOLO.surprise;
  if (n.kind === "file") return HOLO.base;
  if (n.kind === "class") return HOLO.dispatch;
  if (n.kind === "type") return HOLO.success;
  if (n.kind === "doc" || n.kind === "section") return HOLO.tool;
  return communityColor(n.community_id);
}

function nodeGlyph(kind: string): string {
  if (kind === "file") return "F";
  if (kind === "fn") return "fn";
  if (kind === "class") return "C";
  if (kind === "type") return "T";
  if (kind === "doc") return "D";
  if (kind === "section") return "S";
  return kind.slice(0, 2).toUpperCase();
}

function relationColor(edge: Pick<KgEdge, "kind" | "surprise">): string {
  if (edge.surprise) return HOLO.surprise;
  const k = edge.kind.toLowerCase();
  if (k.includes("call") || k.includes("ref")) return HOLO.base;
  if (k.includes("import") || k.includes("use")) return HOLO.dispatch;
  if (k.includes("doc") || k.includes("test")) return HOLO.tool;
  if (k.includes("own") || k.includes("define")) return HOLO.success;
  return HOLO.muted;
}

function edgeGeometry(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  index: number,
): { d: string } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const side = index % 2 === 0 ? 1 : -1;
  const curve = Math.min(140, Math.max(18, dist * 0.22)) * side;
  const nx = (-dy / dist) * curve;
  const ny = (dx / dist) * curve;
  const cp1x = fromX + dx * 0.34 + nx;
  const cp1y = fromY + dy * 0.34 + ny;
  const cp2x = fromX + dx * 0.68 + nx;
  const cp2y = fromY + dy * 0.68 + ny;
  return {
    d: `M ${fromX} ${fromY} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${toX} ${toY}`,
  };
}

function truncateLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function communityColor(c: number): string {
  // Spread hues across a wide arc; OKLCH lifts perceptual contrast vs HSL.
  const hue = (c * 47) % 360;
  return `oklch(0.72 0.16 ${hue})`;
}

function compactPath(file: string, line: number): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const shown =
    parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : file || "unknown";
  return line > 0 ? `${shown}:${line}` : shown;
}

function SidePanel({
  label,
  nodes,
  onPick,
  empty,
}: {
  label: string;
  nodes: KgNode[];
  onPick: (id: string) => void;
  empty: string;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col border-b border-line-soft">
      <div className="text-text-4 text-[10px] uppercase tracking-wider px-3 py-1.5 border-b border-line-soft">
        {label}
      </div>
      <div className="overflow-y-auto flex-1">
        {nodes.length === 0 && (
          <div className="text-text-4 text-[11px] px-3 py-2">{empty}</div>
        )}
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onPick(n.id)}
            className="w-full text-left px-3 py-1.5 hover:bg-bg-2 border-b border-line-soft last:border-b-0"
            title={n.id}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-text-1 text-[11.5px] font-medium truncate flex-1">
                {n.name}
              </span>
              <span className="text-text-4 text-[10px] tabular-nums">
                {n.degree}
              </span>
            </div>
            <div className="text-text-4 text-[10px] truncate">
              {n.kind} · {n.file}
              {n.line > 0 && `:${n.line}`}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SurprisesPanel({
  edges,
  allNodes,
  onPick,
}: {
  edges: KgEdge[];
  allNodes: KgNode[];
  onPick: (id: string) => void;
}) {
  const nameOf = useMemo(() => {
    const m = new Map(allNodes.map((n) => [n.id, n] as const));
    return m;
  }, [allNodes]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="text-text-4 text-[10px] uppercase tracking-wider px-3 py-1.5 border-b border-line-soft">
        Unexpected links
      </div>
      <div className="overflow-y-auto flex-1">
        {edges.length === 0 && (
          <div className="text-text-4 text-[11px] px-3 py-2">
            Nothing unexpected — the clusters stay nicely separate.
          </div>
        )}
        {edges.map((e, i) => {
          const a = nameOf.get(e.from);
          const b = nameOf.get(e.to);
          if (!a || !b) return null;
          return (
            <div
              key={i}
              className="px-3 py-1.5 border-b border-line-soft last:border-b-0"
            >
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => onPick(a.id)}
                  className="text-text-1 hover:underline truncate"
                >
                  {a.name}
                </button>
                <span className="text-text-4">→</span>
                <button
                  type="button"
                  onClick={() => onPick(b.id)}
                  className="text-text-1 hover:underline truncate"
                >
                  {b.name}
                </button>
              </div>
              <div className="text-text-4 text-[10px] truncate">
                {e.kind} · c{a.community_id} ↔ c{b.community_id}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
