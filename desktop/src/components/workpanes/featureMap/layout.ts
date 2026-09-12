// Feature Map — geometry.
//
// Two layouts, both pure and both in canvas units (the viewport applies
// pan and zoom on top):
//
//   • the tree: project root at the top, a bus below it, one column per
//     area hanging off the bus, features stacked in the column, the open
//     feature's flow rows tucked under it, and the open flow's diagram
//     drawn in place under its row. Columns to the right slide over to
//     make room, so nothing ever overlaps and nothing opens a sidebar.
//   • the flow: trigger box, a straight spine of step boxes, "also calls"
//     branches leaning out to the right, a bus, and the outcome under it.
//
// Text is wrapped by character count rather than measured — the boxes are
// sized for a 12px UI face, and the second line ends with an ellipsis when
// the sentence runs long. Rounded connectors use quadratic corners so the
// paths read as drawn, not as a wireframe.

import type { KgFlow, KgFlowStep } from "../../../lib/api";
import {
  flowStatus,
  outcomeLabel,
  triggerBadge,
  type AreaNode,
  type FeatureNode,
  type FlowStatus,
  type MapModel,
} from "./model";

/** Tree constants (canvas px). */
export const T = {
  PAD: 24,
  NODE_W: 156,
  INDENT: 14,
  COL_GAP: 24,
  NODE_H: 40,
  AREA_H: 28,
  ROOT_W: 208,
  ROOT_H: 42,
  ROW_GAP: 6,
  FROW_H: 24,
  FROW_GAP: 4,
  /** Gap between the open flow row and its diagram. */
  DIAGRAM_GAP: 12,
} as const;

export const COL_W = T.INDENT + T.NODE_W;
export const AREA_Y = T.PAD + T.ROOT_H + 44;
export const BUS_Y = T.PAD + T.ROOT_H + 22;

/** Flow-diagram constants (canvas px). */
export const G = {
  NW: 232,
  NH: 40,
  /** Step box height once the text wraps to two lines. */
  NH2: 54,
  TH: 26,
  /** Horizontal reach of a branch stub. */
  LANE: 26,
  BW: 188,
  BH: 20,
  BGAP: 6,
  OW: 172,
  OH: 40,
  OGAP: 10,
  /** Vertical gap between stacked step boxes. */
  STEP_GAP: 14,
  WRAP: 33,
  BRANCH_WRAP: 25,
} as const;

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/** Split a sentence into at most two lines of `max` characters; the
 *  second line gets an ellipsis when the sentence does not fit. */
export function wrap(text: string, max: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  let idx = 0;
  while (idx < words.length && lines.length < 2) {
    const w = words[idx];
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max || !cur) {
      cur = next;
      idx++;
    } else {
      lines.push(cur);
      cur = "";
    }
  }
  if (cur && lines.length < 2) {
    lines.push(cur);
    cur = "";
  }
  const leftover = idx < words.length || cur !== "";
  if (leftover && lines.length === 2) lines[1] = clip(`${lines[1]} …`, max);
  return lines.map((l) => clip(l, max));
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Path through `pts` with quadratic-rounded corners of radius `r`.
 *  Two points give a straight line; collinear runs stay straight. */
export function rounded(pts: Pt[], r = 6): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x} ${pts[0].y}`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const n = pts[i + 1];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr <= 0 || d1 === 0 || d2 === 0) {
      d += ` L${c.x} ${c.y}`;
      continue;
    }
    const ax = c.x - ((c.x - p.x) / d1) * rr;
    const ay = c.y - ((c.y - p.y) / d1) * rr;
    const bx = c.x + ((n.x - c.x) / d2) * rr;
    const by = c.y + ((n.y - c.y) / d2) * rr;
    d += ` L${ax} ${ay} Q${c.x} ${c.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

/** Scale that fits a W×H canvas into a vw×vh viewport with margins,
 *  never zooming in past 1:1 and never below a quarter. */
export function fitScale(W: number, H: number, vw: number, vh: number): number {
  if (W <= 0 || H <= 0 || vw <= 0 || vh <= 0) return 1;
  return Math.max(0.25, Math.min((vw - 32) / W, (vh - 48) / H, 1));
}

// ─── flow diagram ────────────────────────────────────────────────────────

export type StepBox = Rect & {
  index: number;
  step: KgFlowStep;
  lines: string[];
  status: FlowStatus;
};

export type BranchBox = Rect & {
  stepIndex: number;
  label: string;
  file: string;
  line: number;
};

export type OutcomeBox = Rect & {
  kind: "outcome" | "goal";
  title: string;
  text: string;
  status: FlowStatus;
};

export type FlowPath = { d: string; kind: "spine" | "branch" | "bus" };

export type FlowGeom = {
  width: number;
  height: number;
  trigger: Rect & { badge: string; text: string };
  steps: StepBox[];
  branches: BranchBox[];
  outcomes: OutcomeBox[];
  paths: FlowPath[];
  busY: number;
  /** "+N more" per step index, when the also-calls list was cut. */
  more: Map<number, number>;
};

/** Lay one flow out at origin (0,0). */
export function layoutFlow(flow: KgFlow): FlowGeom {
  const status = flowStatus(flow);
  const trigger = {
    x: 0,
    y: 0,
    w: G.NW,
    h: G.TH,
    badge: triggerBadge(flow.trigger.kind),
    text: flow.trigger.text,
  };
  const steps: StepBox[] = [];
  const branches: BranchBox[] = [];
  const paths: FlowPath[] = [];
  const more = new Map<number, number>();
  const cx = G.NW / 2;
  let y = G.TH + 22;
  let prevBottom = G.TH;
  let anyBranch = false;

  flow.steps.forEach((step, index) => {
    const lines = wrap(step.text, G.WRAP);
    const shown = step.also_calls.slice(0, 3);
    const branchStack = shown.length * (G.BH + G.BGAP) - G.BGAP;
    let h: number = lines.length > 1 ? G.NH2 : G.NH;
    if (shown.length > 0) h = Math.max(h, branchStack + 12);
    const box: StepBox = { index, step, lines, status, x: 0, y, w: G.NW, h };
    steps.push(box);
    paths.push({ d: rounded([{ x: cx, y: prevBottom }, { x: cx, y }]), kind: "spine" });

    if (shown.length > 0) {
      anyBranch = true;
      const laneX = G.NW + G.LANE / 2;
      const midY = y + h / 2;
      let by = y + (h - branchStack) / 2;
      const mids: number[] = [];
      shown.forEach((c) => {
        const bh = G.BH;
        branches.push({
          stepIndex: index,
          label: wrap(c.name, G.BRANCH_WRAP)[0],
          file: c.file,
          line: c.line,
          x: G.NW + G.LANE,
          y: by,
          w: G.BW,
          h: bh,
        });
        mids.push(by + bh / 2);
        by += bh + G.BGAP;
      });
      // One stub from the step, a short lane, then a stub into each branch.
      const top = Math.min(midY, mids[0]);
      const bottom = Math.max(midY, mids[mids.length - 1]);
      paths.push({
        d: rounded([{ x: G.NW, y: midY }, { x: laneX, y: midY }]),
        kind: "branch",
      });
      if (bottom > top) {
        paths.push({ d: `M${laneX} ${top} L${laneX} ${bottom}`, kind: "branch" });
      }
      for (const m of mids) {
        paths.push({
          d: rounded([{ x: laneX, y: m }, { x: G.NW + G.LANE, y: m }]),
          kind: "branch",
        });
      }
      if (step.also_calls_total > shown.length) {
        more.set(index, step.also_calls_total - shown.length);
      }
    }
    prevBottom = y + h;
    y = prevBottom + G.STEP_GAP;
  });

  const busY = prevBottom + 18;
  const outcomes: OutcomeBox[] = [];
  const outcomeItems: Array<Pick<OutcomeBox, "kind" | "title" | "text">> = [
    {
      kind: "outcome",
      title: outcomeLabel(flow.outcome.kind),
      text: flow.outcome.text,
    },
  ];
  if (flow.goal) {
    const g = flow.goal;
    outcomeItems.push({
      kind: "goal",
      title: status === "proved" ? "Proved" : status === "gap" ? "Stops short" : "Goal",
      text: g.total > 0 ? `${g.ok} of ${g.total} checks · ${g.text}` : g.text,
    });
  }
  const total = outcomeItems.length * G.OW + (outcomeItems.length - 1) * G.OGAP;
  let ox = cx - total / 2;
  const oy = busY + 14;
  const busPts: number[] = [];
  for (const item of outcomeItems) {
    const x = Math.max(0, ox);
    outcomes.push({ ...item, status, x, y: oy, w: G.OW, h: G.OH });
    busPts.push(x + G.OW / 2);
    ox += G.OW + G.OGAP;
  }
  paths.push({ d: rounded([{ x: cx, y: prevBottom }, { x: cx, y: busY }]), kind: "bus" });
  if (busPts.length > 1) {
    paths.push({
      d: `M${Math.min(...busPts)} ${busY} L${Math.max(...busPts)} ${busY}`,
      kind: "bus",
    });
  }
  for (const bx of busPts) {
    paths.push({ d: rounded([{ x: bx, y: busY }, { x: bx, y: oy }]), kind: "bus" });
  }

  const outcomesRight = Math.max(...outcomes.map((o) => o.x + o.w));
  const width = Math.max(G.NW + (anyBranch ? G.LANE + G.BW : 0), outcomesRight);
  const height = oy + G.OH;
  return { width, height, trigger, steps, branches, outcomes, paths, busY, more };
}

// ─── tree ────────────────────────────────────────────────────────────────

export type AreaBox = Rect & { area: AreaNode };
export type FeatureBox = Rect & { feature: FeatureNode; open: boolean };
export type FlowRowBox = Rect & { flow: KgFlow; open: boolean; status: FlowStatus };

export type TreeSelection = {
  featureId: string | null;
  flowId: string | null;
};

export type TreeLayout = {
  width: number;
  height: number;
  root: Rect;
  areas: AreaBox[];
  features: FeatureBox[];
  flowRows: FlowRowBox[];
  /** Where the open flow's diagram origin sits, if a flow is open. */
  diagramAt: Pt | null;
  paths: string[];
};

/** Lay the whole tree out. `diagram` is the open flow's geometry (already
 *  laid out) so its column can grow and later columns can move over. */
export function layoutTree(
  model: MapModel,
  sel: TreeSelection,
  diagram: FlowGeom | null,
): TreeLayout {
  const areas: AreaBox[] = [];
  const features: FeatureBox[] = [];
  const flowRows: FlowRowBox[] = [];
  const paths: string[] = [];
  let diagramAt: Pt | null = null;

  let x = T.PAD;
  let maxBottom = AREA_Y + T.AREA_H;
  for (const area of model.areas) {
    let colW: number = COL_W;
    const areaBox: AreaBox = { area, x, y: AREA_Y, w: COL_W, h: T.AREA_H };
    areas.push(areaBox);
    const spineX = x + 7;
    let y = AREA_Y + T.AREA_H + 10;
    let lastFeatureMid = y;

    for (const feature of area.features) {
      const open = feature.id === sel.featureId;
      const fb: FeatureBox = { feature, open, x: x + T.INDENT, y, w: T.NODE_W, h: T.NODE_H };
      features.push(fb);
      lastFeatureMid = y + T.NODE_H / 2;
      paths.push(rounded([
        { x: spineX, y: lastFeatureMid },
        { x: x + T.INDENT, y: lastFeatureMid },
      ]));
      y += T.NODE_H;

      if (open && feature.flows.length > 0) {
        const rowX = x + T.INDENT + 12;
        const miniSpineX = x + T.INDENT + 5;
        const miniTop = y;
        let lastRowMid = y;
        y += 6;
        for (const flow of feature.flows) {
          const rowOpen = flow.id === sel.flowId;
          const row: FlowRowBox = {
            flow,
            open: rowOpen,
            status: flowStatus(flow),
            x: rowX,
            y,
            w: T.NODE_W - 12,
            h: T.FROW_H,
          };
          flowRows.push(row);
          lastRowMid = y + T.FROW_H / 2;
          paths.push(rounded([
            { x: miniSpineX, y: lastRowMid },
            { x: rowX, y: lastRowMid },
          ]));
          y += T.FROW_H;
          if (rowOpen && diagram) {
            const dy = y + T.DIAGRAM_GAP;
            const dx = rowX;
            diagramAt = { x: dx, y: dy };
            // Row → trigger box: a short drop from the row's left third.
            paths.push(rounded([
              { x: rowX + 12, y },
              { x: rowX + 12, y: dy },
            ]));
            y = dy + diagram.height;
            colW = Math.max(colW, dx - x + diagram.width);
          }
          y += T.FROW_GAP;
        }
        paths.push(`M${miniSpineX} ${miniTop} L${miniSpineX} ${lastRowMid}`);
        y += 4;
      }
      y += T.ROW_GAP;
    }
    if (area.features.length > 0) {
      paths.push(`M${spineX} ${AREA_Y + T.AREA_H} L${spineX} ${lastFeatureMid}`);
    }
    maxBottom = Math.max(maxBottom, y);
    x += colW + T.COL_GAP;
  }

  const treeRight = x - T.COL_GAP;
  const width = Math.max(treeRight + T.PAD, T.PAD * 2 + T.ROOT_W);
  const rootX = Math.max(T.PAD, (width - T.ROOT_W) / 2);
  const root: Rect = { x: rootX, y: T.PAD, w: T.ROOT_W, h: T.ROOT_H };
  const rootCx = rootX + T.ROOT_W / 2;

  // Root → bus → each area header.
  if (areas.length > 0) {
    const first = areas[0];
    const last = areas[areas.length - 1];
    paths.push(rounded([
      { x: rootCx, y: T.PAD + T.ROOT_H },
      { x: rootCx, y: BUS_Y },
    ]));
    const left = Math.min(first.x + first.w / 2, rootCx);
    const right = Math.max(last.x + last.w / 2, rootCx);
    if (right > left) paths.push(`M${left} ${BUS_Y} L${right} ${BUS_Y}`);
    for (const a of areas) {
      const acx = a.x + a.w / 2;
      paths.push(rounded([{ x: acx, y: BUS_Y }, { x: acx, y: AREA_Y }]));
    }
  }

  return {
    width,
    height: maxBottom + T.PAD,
    root,
    areas,
    features,
    flowRows,
    diagramAt,
    paths,
  };
}
