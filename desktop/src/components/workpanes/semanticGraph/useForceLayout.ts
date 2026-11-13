// The Code Map canvas's layout engine: a d3-force simulation over the
// pieces on screen. It seeds new pieces on a ring, carries surviving ones
// over so a filter change doesn't scramble the picture, pins what was
// dragged, and paints each tick straight into the SVG elements — React
// renders the structure once per change, never per frame.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import type { KgEdge, KgNode } from "../../../lib/api";
import {
  edgeGeometry,
  nodeVisualRadius,
  type EdgeHandle,
  type SimLink,
  type SimNode,
} from "./graphModel";

export function useForceLayout(nodes: KgNode[], edges: KgEdge[]) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  // Bumped exactly once per simulation REBUILD, never per tick. React needs
  // one render to materialise the <g> elements for a new node/edge set; from
  // then on the tick loop writes x/y straight into those elements (see
  // `paintPositions`). Ticking through React state instead meant a settling
  // graph re-rendered every visible node + every edge ~60×/s.
  const [, bumpLayout] = useState(0);
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  // Track sim node objects in a ref so React state changes don't recreate
  // the simulation on every render. The sim is the source of truth for
  // x/y positions; the rAF tick paints them into the DOM directly.
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  // Live DOM handles for everything the sim moves, registered by ref
  // callbacks on the rendered elements. React still owns structure and
  // styling — only the geometry comes from these writes.
  const nodeElsRef = useRef<Map<string, SVGGElement>>(new Map());
  const edgeElsRef = useRef<Map<string, EdgeHandle>>(new Map());

  // Push the sim's current positions into the DOM. Runs on every tick, so it
  // allocates nothing beyond the path string and never touches React state.
  const paintPositions = useCallback(() => {
    const sims = simNodesRef.current;
    for (const [id, el] of nodeElsRef.current) {
      const sn = sims.get(id);
      if (!sn || sn.x == null || sn.y == null) continue;
      el.setAttribute("transform", `translate(${sn.x} ${sn.y})`);
    }
    for (const h of edgeElsRef.current.values()) {
      const a = sims.get(h.from);
      const b = sims.get(h.to);
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null)
        continue;
      const d = edgeGeometry(a.x, a.y, b.x, b.y, h.index).d;
      // One or two <path> children — the base curve plus the animated
      // "surprise" overlay — and both ride the same geometry.
      for (let i = 0; i < h.el.children.length; i++) {
        const child = h.el.children[i];
        if (child.tagName === "path") child.setAttribute("d", d);
      }
    }
  }, []);

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

    sim.on("tick", paintPositions);

    simRef.current?.stop();
    simRef.current = sim;
    // The node/edge set just changed, so let React render it once against the
    // seeded positions; every frame after this is a direct DOM write.
    bumpLayout((t) => (t + 1) & 0xffff);

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

  return { svgRef, size, pinned, setPinned, simRef, simNodesRef, nodeElsRef, edgeElsRef };
}

export type ForceLayout = ReturnType<typeof useForceLayout>;
