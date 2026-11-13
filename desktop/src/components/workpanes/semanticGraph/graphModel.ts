// The Code Map's shared vocabulary: the simulation's node and link shapes,
// the zoom range, the ink each kind of piece is drawn in, and the small
// geometry and label helpers the canvas and the side column both use.

import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { KgEdge, KgNode, KgView } from "../../../lib/api";

export type SimNode = SimulationNodeDatum & {
  id: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  degree: number;
  community_id: number;
  god: boolean;
};

export type SimLink = SimulationLinkDatum<SimNode> & {
  kind: string;
  surprise: boolean;
};

export type SelectedLink = {
  edge: KgEdge;
  other: KgNode;
  direction: "in" | "out";
};

/** A rendered edge group plus the endpoints the tick loop needs to re-curve
 *  it — enough to repaint geometry without consulting React. */
export type EdgeHandle = {
  el: SVGGElement;
  from: string;
  to: string;
  /** Render index — decides which side of the pair the curve bows to. */
  index: number;
};

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 6;
export const HOLO = {
  base: "var(--ui-muted-fg)",
  bright: "var(--ui-fg)",
  hot: "var(--ui-fg)",
  tool: "#c28f2c",
  success: "#5d9a72",
  dispatch: "#8b7ab8",
  surprise: "#d39b37",
  muted: "var(--ui-faint)",
};

/** What the header says about how much of the map is on screen.
 *
 *  Three separate facts, kept separate: how many pieces matched, how many of
 *  those fit, and how many extra pieces are drawn around them for context.
 *  The header used to subtract the last from the first and print
 *  `showing 350 of 16` — a search that found sixteen things, drawn with the
 *  neighbours of all sixteen, reported as though it were hiding matches. */
export function countLabel(view: KgView, searching: boolean): string {
  const shown = Math.max(0, view.nodes.length - view.context);
  const n = (v: number) => v.toLocaleString();
  let label: string;
  if (!searching) {
    label = view.truncated
      ? `showing the ${n(shown)} most connected of ${n(view.matched)}`
      : `showing all ${n(shown)}`;
  } else if (view.truncated) {
    label = `showing ${n(shown)} of ${n(view.matched)} matches`;
  } else {
    label = `${n(view.matched)} ${view.matched === 1 ? "match" : "matches"}`;
  }
  return view.context > 0 ? `${label} + ${n(view.context)} connected` : label;
}

export function nodeVisualRadius(n: Pick<KgNode, "kind" | "degree" | "god">): number {
  const base =
    n.kind === "file" ? 5.5 : n.kind === "class" ? 7 : n.kind === "type" ? 6.5 : 6;
  const bonus = Math.min(6, Math.sqrt(Math.max(0, n.degree)));
  return base + bonus + (n.god ? 3 : 0);
}

export function nodeColor(n: Pick<KgNode, "kind" | "community_id" | "god">): string {
  if (n.god) return HOLO.surprise;
  if (n.kind === "file") return HOLO.base;
  if (n.kind === "class") return HOLO.dispatch;
  if (n.kind === "type") return HOLO.success;
  if (n.kind === "doc" || n.kind === "section") return HOLO.tool;
  return communityColor(n.community_id);
}

export function nodeGlyph(kind: string): string {
  if (kind === "file") return "F";
  if (kind === "fn") return "fn";
  if (kind === "class") return "C";
  if (kind === "type") return "T";
  if (kind === "doc") return "D";
  if (kind === "section") return "S";
  return kind.slice(0, 2).toUpperCase();
}

export function relationColor(edge: Pick<KgEdge, "kind" | "surprise">): string {
  if (edge.surprise) return HOLO.surprise;
  const k = edge.kind.toLowerCase();
  if (k.includes("call") || k.includes("ref")) return HOLO.base;
  if (k.includes("import") || k.includes("use")) return HOLO.dispatch;
  if (k.includes("doc") || k.includes("test")) return HOLO.tool;
  if (k.includes("own") || k.includes("define")) return HOLO.success;
  return HOLO.muted;
}

export function edgeGeometry(
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

export function truncateLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

export function communityColor(c: number): string {
  // Spread hues across a wide arc; OKLCH lifts perceptual contrast vs HSL.
  const hue = (c * 47) % 360;
  return `oklch(0.72 0.16 ${hue})`;
}

export function compactPath(file: string, line: number): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const shown =
    parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : file || "unknown";
  return line > 0 ? `${shown}:${line}` : shown;
}
