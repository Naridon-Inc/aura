// Pure commit-graph lane layout — the math behind the Source Control
// graph rail (VS Code "Source Control → Graph" parity). NO React, NO DOM,
// NO git calls: it takes the topology (`GraphCommit[]`, newest-first, each
// carrying its parent shas) and returns, per row, where the node sits and
// which line segments to draw. Keeping it pure means the renderer is dumb
// and this can be reasoned about / unit-tested in isolation.
//
// The model is the classic "lane reservation" walk used by `git log
// --graph`:
//   • `lanes[i]` = the sha that lane (column) `i` is currently travelling
//     down to reach. null = a free column.
//   • A commit takes the lane(s) that were waiting for it; its first parent
//     continues that lane straight down, each extra parent (a merge) opens
//     or rejoins another lane, and any extra lanes that were waiting for
//     this same commit (multiple children) collapse into it.
// Lanes keep their column for their whole life (no sideways compaction), so
// the through-lines stay vertical and only branch/merge points bend.

import type { GraphCommit } from "./api";

/** One drawable segment inside a single row's cell. A row is split into a
 *  top half (top edge → node centre) and a bottom half (centre → bottom
 *  edge); every line is expressed as a move between two columns within one
 *  of those halves so the renderer needs no global state. */
export type GraphSeg = {
  fromCol: number;
  toCol: number;
  half: "top" | "bottom";
  color: string;
};

export type GraphRowLayout = {
  commit: GraphCommit;
  /** Column the commit's node circle sits in. */
  col: number;
  /** Node colour (by lane). */
  color: string;
  segments: GraphSeg[];
};

export type GraphLayout = {
  rows: GraphRowLayout[];
  /** Widest number of simultaneously-active lanes — drives rail width. */
  laneCount: number;
};

// Lane palette — distinct, calm hues. Arctic-blue leads (lane 0, the
// mainline / current branch usually), the rest are status-neutral accents.
// Deliberately NOT green-as-primary (green is reserved for live status).
export const LANE_COLORS = [
  "#4aa3ff", // arctic blue — mainline
  "#c084fc", // violet
  "#f59e0b", // amber
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#a3e635", // lime
  "#fb7185", // rose
  "#818cf8", // indigo
];

export function laneColor(col: number): string {
  return LANE_COLORS[((col % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

/** First null slot in `lanes`, or the array length (caller appends). */
function firstFree(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

export function computeGraphLayout(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRowLayout[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    // Snapshot lanes entering this row (vertical lines coming from above).
    const lanesIn = lanes.slice();

    // Which lanes were waiting for this commit? (its children's lanes)
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.sha) waiting.push(i);
    }

    // The node's column: the leftmost waiting lane, or a fresh free lane.
    const col = waiting.length > 0 ? waiting[0] : firstFree(lanes);
    if (col >= lanes.length) lanes.length = col + 1;

    const firstParent = commit.parents[0];

    // First parent continues straight down in `col`; a root ends the lane.
    lanes[col] = firstParent ?? null;

    // Other lanes that were waiting for this commit collapse into `col`.
    for (const k of waiting) {
      if (k !== col) lanes[k] = null;
    }

    // Extra parents (merge): rejoin an existing lane already heading to that
    // parent, else open a new lane (reusing a freed column when possible).
    const parentCols: number[] = [];
    if (firstParent) parentCols.push(col);
    for (let p = 1; p < commit.parents.length; p++) {
      const psha = commit.parents[p];
      let pc = lanes.indexOf(psha);
      if (pc === -1) {
        pc = firstFree(lanes);
        if (pc >= lanes.length) lanes.length = pc + 1;
        lanes[pc] = psha;
      }
      parentCols.push(pc);
    }

    // Snapshot lanes leaving this row (vertical lines going below).
    const lanesOut = lanes.slice();

    // ── Build the drawable segments for this row ──────────────────
    const segments: GraphSeg[] = [];

    // Top half: each incoming lane reaches the centre.
    for (let i = 0; i < lanesIn.length; i++) {
      if (lanesIn[i] == null) continue;
      if (lanesIn[i] === commit.sha) {
        // A child's lane terminates at this node — merge it into `col`.
        segments.push({ fromCol: i, toCol: col, half: "top", color: laneColor(i === col ? col : i) });
      } else {
        // Unrelated lane passing straight through.
        segments.push({ fromCol: i, toCol: i, half: "top", color: laneColor(i) });
      }
    }

    // Bottom half: each outgoing lane leaves the centre downward.
    const parentColSet = new Set(parentCols);
    for (let j = 0; j < lanesOut.length; j++) {
      if (lanesOut[j] == null) continue;
      if (parentColSet.has(j)) {
        // A lane branching out of THIS node toward a parent.
        segments.push({ fromCol: col, toCol: j, half: "bottom", color: laneColor(j) });
      } else {
        // Unrelated lane passing straight through.
        segments.push({ fromCol: j, toCol: j, half: "bottom", color: laneColor(j) });
      }
    }

    rows.push({ commit, col, color: laneColor(col), segments });

    // Trim trailing free lanes so the rail doesn't keep growing forever.
    while (lanes.length > 0 && lanes[lanes.length - 1] == null) lanes.pop();
    laneCount = Math.max(laneCount, lanesIn.length, lanesOut.length, col + 1);
  }

  return { rows, laneCount };
}
