// The Code Map's pieces view: a force-directed network of the project's
// files and functions. useForceLayout owns the positions, useGraphCamera the
// pan/zoom/drag, and this file draws: React owns structure and styling, the
// tick loop paints geometry straight into the elements.
//
//   • Continuous rAF tick loop with alpha decay (Verlet-style)
//   • Barnes-Hut O(N log N) repulsion via d3-quadtree
//   • Pan: drag empty space. Zoom: mousewheel (focal-point at cursor).
//   • Drag a node to pin it (fx/fy). Double-click a pinned node to free.
//   • Hover highlights direct neighbours; non-neighbours fade.
//   • Hubs carry a soft amber glow + label always-on.
//   • Unexpected links drawn brighter and thicker.

import { useMemo } from "react";
import type { KgEdge, KgNode } from "../../../lib/api";
import {
  HOLO,
  edgeGeometry,
  nodeColor,
  nodeGlyph,
  nodeVisualRadius,
  relationColor,
  truncateLabel,
} from "./graphModel";
import { GraphZoomBar } from "./GraphZoomBar";
import { useForceLayout } from "./useForceLayout";
import { useGraphCamera } from "./useGraphCamera";

export function GraphCanvas({
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
  const layout = useForceLayout(nodes, edges);
  const { svgRef, size, pinned, setPinned, simNodesRef, nodeElsRef, edgeElsRef } = layout;
  const {
    transform,
    zoomBy,
    onWheel,
    onPointerDownBackground,
    onPointerMove,
    onPointerUp,
    onNodePointerDown,
    onNodeDoubleClick,
    onBackgroundDoubleClick,
    resetView,
    reheat,
    fitGraph,
    fitSelected,
  } = useGraphCamera({
    layout,
    nodes,
    edges,
    selectedId,
    fitSelectionSignal,
    onSelect,
    onHover,
    onClearSelection,
  });

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
    <div className="ui-graph-canvas">
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
              fill="var(--ui-border)"
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

        <rect width={size.w} height={size.h} fill="var(--ui-bg)" />
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
              const handleKey = `${e.from}-${e.to}-${i}`;
              return (
                <g
                  key={handleKey}
                  ref={(el) => {
                    if (el)
                      edgeElsRef.current.set(handleKey, {
                        el,
                        from: e.from,
                        to: e.to,
                        index: i,
                      });
                    else edgeElsRef.current.delete(handleKey);
                  }}
                >
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
                  ref={(el) => {
                    if (el) nodeElsRef.current.set(n.id, el);
                    else nodeElsRef.current.delete(n.id);
                  }}
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
                        stroke="var(--ui-bg)"
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
      <GraphZoomBar
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
