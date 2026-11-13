// The Code Map canvas's camera and hands: pan, zoom about the cursor,
// drag a piece to pin it, fit the whole map or the picked neighbourhood,
// and the single-key shortcuts (0 fit, F fit selection, +/- zoom, R
// restart the layout, Esc clear).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KgEdge, KgNode } from "../../../lib/api";
import { ZOOM_MAX, ZOOM_MIN, nodeVisualRadius } from "./graphModel";
import type { ForceLayout } from "./useForceLayout";

export function useGraphCamera({
  layout,
  nodes,
  edges,
  selectedId,
  fitSelectionSignal,
  onSelect,
  onHover,
  onClearSelection,
}: {
  layout: ForceLayout;
  nodes: KgNode[];
  edges: KgEdge[];
  selectedId: string | null;
  fitSelectionSignal: number;
  onSelect: (id: string, opts?: { fit?: boolean }) => void;
  onHover: (id: string | null) => void;
  onClearSelection: () => void;
}) {
  const { svgRef, size, setPinned, simRef, simNodesRef } = layout;
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const nodeById = useMemo(() => {
    return new Map(nodes.map((n) => [n.id, n] as const));
  }, [nodes]);

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
      // Drop the drag's heat floor. `onNodePointerDown` raises alphaTarget so
      // the layout stays fluid under the cursor; leaving it raised means alpha
      // can never decay past it and the sim runs forever after one drag.
      simRef.current?.alphaTarget(0);
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

  return {
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
  };
}
