// Crew graph layout — turns the flat ready_view into a positioned picture of
// the work. Pure and deterministic (no Date/random), so it's unit-testable and
// renders the same every time.
//
// The big idea: a real workflow doesn't look like a spreadsheet. It's a TIMELINE
// OF ZONES — differently-sized clusters of work, scattered left→right in the
// order they begin, grouped under the bigger thing they serve, connected only
// where they genuinely depend on each other. So that's what we draw:
//
//   • Each distinct goal becomes a compact, titled GOAL ZONE — a rounded box
//     sized to its OWN work. A 4-task goal is a small tile; a 36-task goal is a
//     broad one. The cards inside are ordered along the timeline (wave/sprint),
//     wrapped into ≈√n columns, so zones come in many shapes — never one uniform
//     global grid.
//   • Goals that roll up to the same objective sit inside a full-width OBJECTIVE
//     BAND, and their zones FLOW LEFT→RIGHT across it in arrival order (the goal
//     whose work starts earliest leads), wrapping only on very large objectives.
//     Each band is its own little timeline; the bands stack with generous air.
//   • Tasks that carry an objective but no goal collect into a "General tasks"
//     zone under that objective, so nothing tagged ever falls through.
//   • Work with NO goal AND NO objective drops to the bottom as collapsible
//     work-groups — the "no set order yet" pile.
//
// Crucially this groups tagged work whether or not it has dependency EDGES. A
// freshly-synced Jira board often has 600 goal/objective-tagged tasks with no
// `depends_on` links at all; a task's GROUP comes from its tags, and its
// POSITION comes from the timeline — edges are a bonus, not a requirement.
//
// Two kinds of edge live in the model. Task→task links are kept so clicking a
// card lights its whole chain, but at rest only the SHORT lane-local ones draw —
// hundreds of long arrows are the spaghetti we kill. Separately we surface
// goal↔goal INTERCONNECTIONS: one faint connector per pair of goals joined by a
// cross-goal dependency (not every task arrow) — the honest "these goals are
// linked" signal, empty when goals are self-contained.
//
// Cycles (which shouldn't happen, but a hand-edited graph could create one) are
// broken by treating the back-edge as depth 0 rather than looping forever.

import type { LoopTask, ReadyViewDto, TaskStep } from "../../../lib/api";
import { currentStepStory } from "../../../lib/taskSteps";
import { crewOf } from "./crewControl";

/** Board-plan steps keyed by `board_task_id` — the join that lets a working
 *  node say what it is actually on ("Step 3 of 7 — wire the picker") instead of
 *  the generic "an agent is building this now". Empty map ⇒ every node falls
 *  back to the generic sentence, so this stays optional end to end. */
export type BoardStepsByTaskId = ReadonlyMap<string, TaskStep[]>;

export type CrewNodeStatus =
  | "ready"
  | "working"
  | "blocked"
  | "paused"
  | "done"
  | "other";

export type CrewGraphNode = {
  id: string;
  title: string;
  status: CrewNodeStatus;
  priority: string;
  agentKind: string | null;
  /** Pixel top-left of the node card. */
  x: number;
  y: number;
  /** Column index within its lane's wrapped grid (0 = left). Kept for debugging
   *  / stable keys. */
  col: number;
  /** True when this node sits in the un-ordered cluster pile (no goal/objective
   *  tag), false when it's part of a goal/objective lane. */
  free: boolean;
  /** The goal/objective/flow lane this node belongs to, or null for a cluster
   *  node. Lets the renderer tell an edge that stays inside one lane from a rare
   *  cross-lane one. */
  regionId: string | null;
  /** When this node is a child inside an expanded work-group section, the id of
   *  that cluster (`epic:<id>` / `sprint:<slug>` / `unsorted`). Null otherwise. */
  clusterId: string | null;
  /** The one-line plain-language STORY the card tells under its title — what an
   *  agent is doing now, what it waits on (named), what it delivered, or what it
   *  builds. Evolves with the task's state; never the raw status enum. */
  story: string;
  /** Which TEAMMATE owns this on the board (display name), distinct from the
   *  agentKind (which robot works it). Null when nobody's assigned. Lets a card
   *  show "assigned to someone" at a glance. */
  assignee: string | null;
  /** In-view connection counts — how many tasks this one waits on, and how many
   *  wait on it. Precomputed here so a card's hover summary never re-walks the
   *  edge list. */
  waitingCount: number;
  unblockCount: number;
};

export type CrewGraphEdge = {
  /** Blocker (sits earlier on the timeline). */
  from: string;
  /** Dependent (this node waits on `from`). */
  to: string;
};

/** A roll-up of a set of tasks, shown on a header band so you read the shape of
 *  a group without opening it — total, how many done, how many need attention,
 *  and who's on it. Pure counts, no styling. */
export type CrewClusterStat = {
  total: number;
  done: number;
  working: number;
  /** Critical + high together — the "needs attention" count. */
  attention: number;
  /** Distinct human assignees (display names), for avatars on the header. */
  assignees: string[];
  /** Distinct agent kinds across the group, for the agent badges. */
  agentKinds: string[];
};

/** A GOAL ZONE — one goal's worth of work, drawn as a compact titled box sized
 *  to its own task count and dropped onto the timeline (header strip on top, a
 *  small pack of its task cards below). `kind:"flow"` is the fallback for an
 *  objective-only "General tasks" zone, or for connected work the planner never
 *  tagged: still boxed and titled so it never melts back into the wall. */
export type CrewRegion = {
  /** `goal:<text>` / `obj:<text>` / `flow:<rootId>`. */
  id: string;
  kind: "goal" | "flow";
  title: string;
  /** "12 steps · 4 waves" — the shape in a line. */
  subtitle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Height of the titled header strip at the top of the zone. */
  headerHeight: number;
  stat: CrewClusterStat;
  /** The objective band this zone sits in, or null when it stands alone. */
  objectiveId: string | null;
  /** Always true now — a goal zone always shows its task cards. Kept on the type
   *  so the renderer and any consumer can read it uniformly. */
  expanded: boolean;
  /** The Goal anchor block (far left of the flow) and the Result block (far
   *  right). Absolute pixel rects. The Goal block restates what this flow sets
   *  out to build; the Result block carries the progress maths (how far done,
   *  how many proven). */
  goalBlock: { x: number; y: number; w: number; h: number };
  resultBlock: { x: number; y: number; w: number; h: number };
};

/** An OBJECTIVE SECTION — the larger goal a few goal-lanes roll up to. Drawn as
 *  a full-width titled band that the goal lanes nest inside, so the board reads
 *  objective → goal → task instead of one undifferentiated mass. */
export type CrewObjective = {
  /** `objective:<text>`. */
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Height of the clickable/titled header band. */
  headerHeight: number;
  /** How many goal lanes live inside. */
  regionCount: number;
  stat: CrewClusterStat;
};

/** A WORK-GROUP section in the un-ordered area — an epic, a sprint, or the
 *  leftover "Unsorted" pile, for tasks that carry NO goal and NO objective.
 *  Collapsed, a cluster is just its header (and emits NO task nodes); expanded,
 *  its children grid sits inside the box and the box grows to hold them. */
export type CrewCluster = {
  /** Stable key: `epic:<parentId>` | `sprint:<slug>` | `crew:<slug>` | `unsorted`. */
  id: string;
  kind: "epic" | "sprint" | "crew" | "unsorted";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Height of the clickable header band (the collapsed height). */
  headerHeight: number;
  expanded: boolean;
  stat: CrewClusterStat;
};

export type CrewGraphLayout = {
  nodes: CrewGraphNode[];
  edges: CrewGraphEdge[];
  /** Goal↔goal interconnections — one entry per pair of goal zones joined by a
   *  cross-goal task dependency (deduped, NOT per task arrow). `from`/`to` are
   *  region ids. Empty when every goal is self-contained. The renderer draws
   *  these as faint zone-to-zone connectors so "these goals are linked" reads
   *  without hundreds of long task arrows. */
  regionEdges: CrewGraphEdge[];
  width: number;
  height: number;
  /** The goal/objective/flow zones, each a titled box with its timeline pack. */
  regions: CrewRegion[];
  /** The objective sections that wrap goal lanes. Empty when nothing rolls up to
   *  a larger goal. */
  objectives: CrewObjective[];
  /** The collapsible work-group sections in the un-ordered area (epics /
   *  sprints / Unsorted). Only an expanded one contributes task nodes. */
  clusters: CrewCluster[];
  /** Y where the un-ordered pile starts, or null when everything's tagged. The
   *  renderer drops a "no set order yet" divider there. */
  gridStartY: number | null;
  /** Count of un-grouped (no goal/objective) tasks in the un-ordered pile. */
  freeCount: number;
  /** Count of tasks placed in goal/objective lanes. */
  connectedCount: number;
};

// Card + spacing geometry. Exported so the renderer draws to the exact same
// anchor points the layout reserved.
export const CREW_NODE_W = 208;
// Tall enough for two lines: the title, and the one-line evolving "story" of
// what the task is doing / waiting on / delivered.
export const CREW_NODE_H = 70;
export const CREW_ROW_GAP = 16;
export const CREW_PAD = 36;
// Tasks inside a goal zone pack snug — short local links, no long routes.
const CREW_GRID_GAP_X = 16;

// GOAL ZONE geometry — one goal's worth of work, dropped onto the timeline. Its
// identity now lives entirely in the Goal bookend on the far left (no separate
// title strip — a vibecoder flagged the goal showing twice), so the zone only
// reserves a slim top gutter for the per-wave labels that ride above the columns.
export const CREW_ZONE_HEADER_H = 22;
const CREW_ZONE_PAD = 16;
// Air between goal zones along the timeline. Deliberately WIDER than the
// within-flow CREW_LAYER_GAP_X below: the visible gap from one flow's Result
// bookend to the next flow's Goal bookend works out to 2·ZONE_PAD + this, so we
// keep it clearly above the in-flow Goal→task rhythm. Otherwise sequential goals
// (Goal → … → Result → Goal → … → Result) run at the same spacing as the boxes
// INSIDE a flow and blur into one undifferentiated strip — the "looks bad" a
// vibecoder flagged when goals chain.
const CREW_ZONE_GAP_X = 120;
const CREW_ZONE_GAP_Y = 40; // air between wrapped rows of zones
const CREW_ZONE_MAX_COLS = 6; // edgeless-pile fallback never wider than this
// Between dependency columns inside a connected goal — wider than the row gap so
// the edges flowing left→right between layers have room to breathe and read as
// a graph, not a table.
const CREW_LAYER_GAP_X = 76;

// BOOKENDS — every goal flow opens with a Goal anchor block on the far left and
// closes with a Result block on the far right, so a flow always reads "this is
// what we set out to build → … the steps … → here's what landed (and how far)."
// Same width as a task card so they sit in the layer rhythm; a touch taller.
export const CREW_BOOKEND_W = CREW_NODE_W;
export const CREW_BOOKEND_H = 96;
// One full layer-gap of air on each side, so the goal block reads as column −1
// and the result block as column +1 of the dependency flow.
const CREW_BOOKEND_STRIDE = CREW_BOOKEND_W + CREW_LAYER_GAP_X;

// OBJECTIVE BAND geometry — the larger goal a handful of goal-zones roll up to:
// a full-width titled container the zones flow left→right inside (wrapping only
// on very large objectives), with generous air down to the next band.
export const CREW_OBJ_HEADER_H = 56;
const CREW_OBJ_INNER_PAD = 26;
const CREW_OBJ_GAP_Y = 64; // generous air between one larger goal and the next

// Gap between the tagged sections and the un-ordered pile below them.
const CREW_SECTION_GAP = 56;
// Work-group (un-ordered) section geometry.
export const CREW_CLUSTER_HEADER_H = 48;
const CREW_CLUSTER_GAP = 18;
const CREW_CLUSTER_INNER_PAD = 14;

// The board grows to fit its widest objective row of zones, within bounds — so
// each objective reads as ONE horizontal timeline of goals when it reasonably
// can, and only wraps on genuinely huge objectives. Pans/zooms freely, so this
// is about reading shape, not fitting a viewport.
const CREW_CONTENT_W_MIN = 1800;
const CREW_CONTENT_W_MAX = 9000;
const CREW_DEFAULT_WIDTH = CREW_CONTENT_W_MIN;

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_ORDER: Record<CrewNodeStatus, number> = {
  working: 0,
  ready: 1,
  blocked: 2,
  paused: 3,
  other: 4,
  done: 5,
};

// Wave letters map to a left→right timeline order.
const WAVE_ORDER: Record<string, number> = {
  a: 0,
  b: 1,
  c: 2,
  d: 3,
  e: 4,
  f: 5,
  g: 6,
  h: 7,
};

export type Labeled = { task: LoopTask; status: CrewNodeStatus };

/** One short line of the task's own words — collapsed whitespace, clipped. */
function snippet(s: string, max = 52): string {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The plain-language STORY a card tells under its title. It EVOLVES with the
 *  task: what an agent is doing now, what it's waiting on (named, not an id),
 *  what it delivered, or — at the head of a flow — what it actually builds. */
export function storyFor(
  l: Labeled,
  byId: Map<string, Labeled>,
  isRoot: boolean,
  boardSteps?: BoardStepsByTaskId,
): string {
  const { task, status } = l;
  if (status === "working") {
    // Say what's actually happening, from the board row's plan, when this node
    // is joined to one. Falls back to the generic sentence only when there is
    // no plan to report — a working node with no board task, or a plan that's
    // been fully ticked.
    const steps = task.board_task_id
      ? boardSteps?.get(task.board_task_id)
      : undefined;
    const story = steps ? currentStepStory({ steps }) : null;
    return story ?? "An agent is building this now";
  }
  const what = snippet(task.input);
  if (status === "done") return what ? `Built · ${what}` : "Built and committed";
  const deps = (task.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter((d): d is Labeled => !!d);
  if (deps.length > 0) {
    const unmet = deps.filter((d) => d.status !== "done");
    const ref = (unmet[0] ?? deps[0]).task.title;
    const more = deps.length > 1 ? ` +${deps.length - 1} more` : "";
    if (status === "blocked" || unmet.length > 0)
      return `Waiting on ${ref}${more}`;
    return `Clear to start. ${ref} landed`;
  }
  if (what) return what;
  return isRoot ? "Starts the whole flow" : "Ready to start";
}

function flatten(view: ReadyViewDto): Labeled[] {
  return [
    ...view.working.map((task) => ({ task, status: "working" as const })),
    ...view.ready.map((task) => ({ task, status: "ready" as const })),
    ...view.blocked.map((b) => ({ task: b.task, status: "blocked" as const })),
    ...view.paused.map((task) => ({ task, status: "paused" as const })),
    ...view.done.map((task) => ({ task, status: "done" as const })),
    ...view.other.map((task) => ({ task, status: "other" as const })),
  ];
}

const byStatusThenPriority = (a: Labeled, b: Labeled) =>
  STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
  (PRIORITY_ORDER[a.task.priority] ?? 2) -
    (PRIORITY_ORDER[b.task.priority] ?? 2) ||
  a.task.title.localeCompare(b.task.title);

/** Roll up a set of tasks into the header counts shown on a lane/objective/
 *  cluster band. */
function rollup(children: Labeled[]): CrewClusterStat {
  const stat: CrewClusterStat = {
    total: children.length,
    done: 0,
    working: 0,
    attention: 0,
    assignees: [],
    agentKinds: [],
  };
  const seenAssignee = new Set<string>();
  const seenAgent = new Set<string>();
  for (const c of children) {
    if (c.status === "done") stat.done += 1;
    if (c.status === "working") stat.working += 1;
    if (c.task.priority === "critical" || c.task.priority === "high")
      stat.attention += 1;
    const who = c.task.assignee?.trim();
    if (who && !seenAssignee.has(who)) {
      seenAssignee.add(who);
      stat.assignees.push(who);
    }
    const ak = c.task.agent_kind?.trim();
    if (ak && !seenAgent.has(ak)) {
      seenAgent.add(ak);
      stat.agentKinds.push(ak);
    }
  }
  return stat;
}

/** First tag with the given lowercase prefix that ends in a colon
 *  (`goal:` / `objective:` / `sprint:`), with the prefix stripped, or null. */
function tagValue(task: LoopTask, prefix: string): string | null {
  const tag = (task.tags ?? []).find((t) =>
    t.toLowerCase().startsWith(prefix),
  );
  if (!tag) return null;
  const v = tag.slice(tag.indexOf(":") + 1).trim();
  return v || null;
}

/** First tag with the given dash-style lowercase prefix (`wave-`, `sprint-`),
 *  with the prefix stripped — for imported boards that tag `wave-a` / `sprint-2`
 *  rather than `wave:a`. Null when absent. */
function dashTagValue(task: LoopTask, prefix: string): string | null {
  const tag = (task.tags ?? []).find((t) => t.toLowerCase().startsWith(prefix));
  if (!tag) return null;
  const v = tag.slice(prefix.length).trim();
  return v || null;
}

/** A task's position on the shared left→right TIMELINE: its wave (a…h → 0…7),
 *  else its sprint number, else its local dependency depth pushed to the end so
 *  untagged work trails the scheduled work. Pure ordering only — it never sets a
 *  pixel column, just the sort order inside a lane's wrapped grid. */
function timelineRank(task: LoopTask, depth: number): number {
  const w = dashTagValue(task, "wave-");
  if (w) {
    const o = WAVE_ORDER[(w[0] ?? "").toLowerCase()];
    if (o !== undefined) return o;
  }
  const s = dashTagValue(task, "sprint-") ?? tagValue(task, "sprint:");
  if (s) {
    const n = parseInt(s, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 100 + depth;
}

/** The id-like leading segment of a title — "PRD-09 · T2.2 — Frontend" →
 *  "PRD-09". Groups an imported board that carries no goal tags but names tasks
 *  "<group> · <item>". Returns a segment only when the title splits on a
 *  separator and the lead is short enough to be a label. */
function idPrefix(title: string): string | null {
  const parts = (title ?? "").trim().split(/\s*[·—:]\s*/);
  if (parts.length < 2) return null;
  const head = (parts[0] ?? "").trim();
  if (head.length < 2 || head.length > 24) return null;
  return head;
}

/** The label shared by an epic's children when the parent task itself isn't in
 *  view — "PRD-09 · T2.2" + "PRD-09 · T2.1" → "PRD-09". Null unless every member
 *  agrees. */
function commonTitlePrefix(members: Labeled[]): string | null {
  const seg = (t: string) => (t.split(/[·—:]/)[0] ?? "").trim();
  const first = seg(members[0]?.task.title ?? "");
  if (!first) return null;
  return members.every((m) => seg(m.task.title) === first) ? first : null;
}

type ZoneLayout = {
  offsets: Map<string, { x: number; y: number; col: number }>;
  width: number;
  height: number;
  cols: number;
  /** Local (task-area-relative) top-left of the Goal anchor block (far left) and
   *  the Result block (far right). The task pack is shifted right to make room. */
  goal: { x: number; y: number };
  result: { x: number; y: number };
};

/** Frame a raw task pack with the two bookends: shift every task right by one
 *  bookend stride (so the Goal block owns column −1), grow the width by a stride
 *  on each side, and centre both blocks against the pack's height. */
function withBookends(raw: {
  offsets: Map<string, { x: number; y: number; col: number }>;
  width: number;
  height: number;
  cols: number;
}): ZoneLayout {
  const offsets = new Map<string, { x: number; y: number; col: number }>();
  for (const [id, o] of raw.offsets)
    offsets.set(id, { x: o.x + CREW_BOOKEND_STRIDE, y: o.y, col: o.col });
  const width = raw.width + 2 * CREW_BOOKEND_STRIDE;
  const height = Math.max(raw.height, CREW_BOOKEND_H);
  const by = Math.max(0, (height - CREW_BOOKEND_H) / 2);
  return {
    offsets,
    width,
    height,
    cols: raw.cols,
    goal: { x: 0, y: by },
    result: { x: width - CREW_BOOKEND_W, y: by },
  };
}

/** Pack a set of tasks as a compact ≈√n grid (landscape-biased). Used only for
 *  an EDGELESS goal — a pure parallel pile where there's no graph to draw, so a
 *  small tile reads honestly as "these all run side by side". */
function packGrid(members: Labeled[]): ZoneLayout {
  const sorted = [...members].sort(
    (a, b) =>
      timelineRank(a.task, 0) - timelineRank(b.task, 0) ||
      byStatusThenPriority(a, b),
  );
  const n = sorted.length;
  const cols = Math.max(
    1,
    Math.min(CREW_ZONE_MAX_COLS, Math.round(Math.sqrt(n) * 1.4)),
  );
  const offsets = new Map<string, { x: number; y: number; col: number }>();
  sorted.forEach((l, i) => {
    offsets.set(l.task.id, {
      x: (i % cols) * (CREW_NODE_W + CREW_GRID_GAP_X),
      y: Math.floor(i / cols) * (CREW_NODE_H + CREW_ROW_GAP),
      col: i % cols,
    });
  });
  const usedCols = Math.max(1, Math.min(cols, n));
  const rows = Math.max(1, Math.ceil(n / cols));
  return withBookends({
    offsets,
    width: usedCols * CREW_NODE_W + (usedCols - 1) * CREW_GRID_GAP_X,
    height: rows * CREW_NODE_H + (rows - 1) * CREW_ROW_GAP,
    cols: usedCols,
  });
}

/** Lay one goal's tasks out as a real left→right DEPENDENCY GRAPH (the "view of
 *  the graph" a vibecoder asked for — not a table). X is the longest-path LAYER:
 *  roots sit in the left column, each task that waits on them a column further
 *  right, and so on. Y within a layer is chosen by the average position of a
 *  task's blockers (a barycentre pass), so the connecting edges run mostly
 *  straight across with few crossings. An edgeless goal has no graph to show, so
 *  it falls back to a compact grid. Returns offsets relative to the zone's
 *  task-area origin plus the pack's own width/height. Pure + cycle-safe. */
function layoutGoalZone(members: Labeled[]): ZoneLayout {
  const memberIds = new Set(members.map((m) => m.task.id));
  const byId = new Map(members.map((m) => [m.task.id, m] as const));
  // In-zone blockers only (ignore deps that point outside this goal).
  const blockersOf = (l: Labeled): string[] =>
    (l.task.depends_on ?? []).filter(
      (d) => d !== l.task.id && memberIds.has(d),
    );
  const connected = members.some((m) => blockersOf(m).length > 0);
  if (!connected) return packGrid(members);

  // Longest-path layer (cycle-safe): a task sits one column right of its
  // deepest blocker.
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle — break it
    visiting.add(id);
    let L = 0;
    const l = byId.get(id);
    if (l) for (const b of blockersOf(l)) L = Math.max(L, layerOf(b) + 1);
    visiting.delete(id);
    layer.set(id, L);
    return L;
  };
  for (const m of members) layerOf(m.task.id);

  const byLayer = new Map<number, Labeled[]>();
  let maxLayer = 0;
  for (const m of members) {
    const L = layer.get(m.task.id) ?? 0;
    maxLayer = Math.max(maxLayer, L);
    const bucket = byLayer.get(L) ?? byLayer.set(L, []).get(L)!;
    bucket.push(m);
  }

  // Slot (vertical index) per task. Layer 0 seeds on timeline/status; deeper
  // layers sort by the mean slot of their blockers so edges straighten out.
  const slot = new Map<string, number>();
  for (let L = 0; L <= maxLayer; L++) {
    const arr = byLayer.get(L) ?? [];
    if (L === 0) {
      arr.sort(
        (a, b) =>
          timelineRank(a.task, 0) - timelineRank(b.task, 0) ||
          byStatusThenPriority(a, b),
      );
    } else {
      const bary = (l: Labeled): number => {
        const ss = blockersOf(l)
          .map((b) => slot.get(b))
          .filter((s): s is number => s !== undefined);
        return ss.length ? ss.reduce((x, y) => x + y, 0) / ss.length : 0;
      };
      arr.sort((a, b) => bary(a) - bary(b) || byStatusThenPriority(a, b));
    }
    arr.forEach((l, i) => slot.set(l.task.id, i));
  }

  const offsets = new Map<string, { x: number; y: number; col: number }>();
  let tallest = 1;
  for (const [, arr] of byLayer) tallest = Math.max(tallest, arr.length);
  for (const m of members) {
    const L = layer.get(m.task.id) ?? 0;
    const s = slot.get(m.task.id) ?? 0;
    offsets.set(m.task.id, {
      x: L * (CREW_NODE_W + CREW_LAYER_GAP_X),
      y: s * (CREW_NODE_H + CREW_ROW_GAP),
      col: L,
    });
  }
  const layerCount = maxLayer + 1;
  return withBookends({
    offsets,
    width: layerCount * CREW_NODE_W + (layerCount - 1) * CREW_LAYER_GAP_X,
    height: tallest * CREW_NODE_H + (tallest - 1) * CREW_ROW_GAP,
    cols: layerCount,
  });
}

/** A lane's one-line shape: step count plus how far it stretches across the
 *  timeline (waves / sprints) so the header tells you it's spread, not piled. */
function laneSubtitle(members: Labeled[]): string {
  const n = members.length;
  if (n <= 1) return "1 step";
  const waves = new Set<string>();
  const sprints = new Set<string>();
  for (const m of members) {
    const w = dashTagValue(m.task, "wave-");
    if (w) waves.add((w[0] ?? "").toLowerCase());
    const s = dashTagValue(m.task, "sprint-") ?? tagValue(m.task, "sprint:");
    if (s) sprints.add(s.toLowerCase());
  }
  if (waves.size > 1) return `${n} steps · ${waves.size} waves`;
  if (sprints.size > 1) return `${n} steps · ${sprints.size} sprints`;
  return `${n} steps`;
}

type RegionAccum = {
  id: string;
  kind: CrewRegion["kind"];
  goalText: string | null;
  objText: string | null;
  epicParentId: string | null;
  prefixLabel: string | null;
  members: Labeled[];
};

export function computeCrewGraphLayout(
  view: ReadyViewDto,
  targetWidth: number = CREW_DEFAULT_WIDTH,
  /** Which un-ordered work-group sections are open. A collapsed cluster shows
   *  only its header band and emits no task nodes. */
  expanded: ReadonlySet<string> = new Set(),
  /** Board-plan steps keyed by `board_task_id`, so a working node tells its
   *  real step. Optional — omit and every node uses the generic sentence. */
  boardSteps?: BoardStepsByTaskId,
): CrewGraphLayout {
  const labeled = flatten(view);

  const byId = new Map<string, Labeled>();
  for (const l of labeled) byId.set(l.task.id, l);

  // Edges — kept for the click-to-light-the-chain interaction, never drawn by
  // default (that's the spaghetti we're killing).
  const edges: CrewGraphEdge[] = [];
  const connected = new Set<string>();
  // Per-node connection tallies — how many tasks each one waits on, and how many
  // wait on it — so a card can summarise its place in the flow without the
  // renderer re-walking edges.
  const waitingCount = new Map<string, number>();
  const unblockCount = new Map<string, number>();
  for (const l of labeled) {
    for (const dep of l.task.depends_on ?? []) {
      if (byId.has(dep)) {
        edges.push({ from: dep, to: l.task.id });
        connected.add(dep);
        connected.add(l.task.id);
        waitingCount.set(l.task.id, (waitingCount.get(l.task.id) ?? 0) + 1);
        unblockCount.set(dep, (unblockCount.get(dep) ?? 0) + 1);
      }
    }
  }

  // contentW / outerW are sized adaptively below, once every goal zone's
  // footprint is known (a board is as wide as its widest objective's row).
  const nodes: CrewGraphNode[] = [];

  // ── Group EVERY task by its tags (edges optional) ───────────────────────
  // A task's lane comes from its tags, most-specific seam first:
  //   goal: → its goal lane
  //   objective: (no goal) → a "General tasks" lane under that objective
  //   else, only if it has dependency edges: its epic / id-prefix / flow chain
  //   else → null: a truly loose task, handled by the cluster pile below.
  // This is the fix for imported boards: 600 goal/objective-tagged tasks with no
  // depends_on links now land in real lanes instead of one orderless heap.

  // Union-find over connected, fully-untagged nodes so an unplanned blob still
  // groups into one flow lane per real chain.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = a;
    while (parent.get(c) && parent.get(c) !== r) {
      const nxt = parent.get(c)!;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    parent.set(find(a), find(b));
  };
  const goalOf = new Map<string, string | null>();
  const objOf = new Map<string, string | null>();
  const parentOf = new Map<string, string | null>();
  const prefixOf = new Map<string, string | null>();
  for (const l of labeled) {
    goalOf.set(l.task.id, tagValue(l.task, "goal:"));
    objOf.set(l.task.id, tagValue(l.task, "objective:"));
    parentOf.set(l.task.id, l.task.parent_task_id ?? null);
    prefixOf.set(l.task.id, idPrefix(l.task.title));
    parent.set(l.task.id, l.task.id);
  }
  // Flow lanes only catch connected tasks with NO tag of any kind.
  const flowEligible = (id: string) =>
    connected.has(id) &&
    !goalOf.get(id) &&
    !objOf.get(id) &&
    !parentOf.get(id) &&
    !prefixOf.get(id);
  for (const e of edges) {
    if (flowEligible(e.from) && flowEligible(e.to)) union(e.from, e.to);
  }

  // null → this task is loose (no goal/objective, and either edge-less or an
  // edged-but-untagged stray); it goes to the cluster pile, not a lane.
  const regionKeyOf = (id: string): string | null => {
    const g = goalOf.get(id);
    if (g) return `goal:${g}`;
    const o = objOf.get(id);
    if (o) return `obj:${o}`;
    if (!connected.has(id)) return null;
    const p = parentOf.get(id);
    if (p) return `epic:${p}`;
    const pre = prefixOf.get(id);
    if (pre) return `prefix:${pre.toLowerCase()}`;
    return `flow:${find(id)}`;
  };

  const regionMap = new Map<string, RegionAccum>();
  const regionOrder: string[] = [];
  const looseLabeled: Labeled[] = [];
  for (const l of labeled) {
    const key = regionKeyOf(l.task.id);
    if (key === null) {
      looseLabeled.push(l);
      continue;
    }
    let acc = regionMap.get(key);
    if (!acc) {
      const g = goalOf.get(l.task.id) ?? null;
      const o = objOf.get(l.task.id) ?? null;
      acc = {
        id: key,
        kind: g ? "goal" : "flow",
        goalText: g,
        objText: o,
        epicParentId: key.startsWith("epic:")
          ? (parentOf.get(l.task.id) ?? null)
          : null,
        prefixLabel: key.startsWith("prefix:")
          ? (prefixOf.get(l.task.id) ?? null)
          : null,
        members: [],
      };
      regionMap.set(key, acc);
      regionOrder.push(key);
    }
    acc.members.push(l);
  }

  // Resolve each lane's title + objective (no geometry yet).
  type RegionMeta = {
    title: string;
    objectiveId: string | null;
    kind: CrewRegion["kind"];
  };
  const meta = new Map<string, RegionMeta>();
  for (const key of regionOrder) {
    const acc = regionMap.get(key)!;
    let title: string;
    if (key.startsWith("goal:")) {
      title = acc.goalText ?? "Goal";
    } else if (key.startsWith("obj:")) {
      title = "General tasks";
    } else if (acc.prefixLabel) {
      title = acc.prefixLabel;
    } else if (acc.epicParentId) {
      title =
        byId.get(acc.epicParentId)?.task.title ??
        commonTitlePrefix(acc.members) ??
        "Epic";
    } else {
      title = acc.members[0]?.task.title ?? "Connected work";
    }
    // Objective: an obj-lane IS its objective; a goal-lane takes the first
    // objective tag its members carry; flow/epic lanes only if tagged.
    let objectiveId: string | null = null;
    if (key.startsWith("obj:")) {
      objectiveId = `objective:${acc.objText ?? ""}`;
    } else {
      for (const m of acc.members) {
        const o = objOf.get(m.task.id);
        if (o) {
          objectiveId = `objective:${o}`;
          break;
        }
      }
    }
    meta.set(key, { title, objectiveId, kind: acc.kind });
  }

  // "Arrival" — when a goal's work lands on the shared timeline, the average of
  // its tasks' wave/sprint ranks. Goals are plotted in arrival order so the
  // board reads as the work appears (early goals first), not as one undifferent-
  // iated dump sorted by raw size.
  const arrival = new Map<string, number>();
  for (const key of regionOrder) {
    const ms = regionMap.get(key)!.members;
    let sum = 0;
    for (const m of ms) sum += timelineRank(m.task, 0);
    arrival.set(key, ms.length > 0 ? sum / ms.length : 0);
  }

  // ── Group lanes by objective, then place sections top-to-bottom ─────────
  const objIds: string[] = [];
  const objToRegions = new Map<string, string[]>();
  const looseRegions: string[] = [];
  for (const key of regionOrder) {
    const oid = meta.get(key)!.objectiveId;
    if (oid) {
      if (!objToRegions.has(oid)) {
        objToRegions.set(oid, []);
        objIds.push(oid);
      }
      objToRegions.get(oid)!.push(key);
    } else {
      looseRegions.push(key);
    }
  }
  const regionSize = (key: string) => regionMap.get(key)!.members.length;
  // Order goals by when they arrive on the timeline, then bigger goals first as
  // a tiebreak, then title for stability.
  const sortRegionKeys = (keys: string[]) =>
    [...keys].sort(
      (a, b) =>
        (arrival.get(a) ?? 0) - (arrival.get(b) ?? 0) ||
        regionSize(b) - regionSize(a) ||
        meta.get(a)!.title.localeCompare(meta.get(b)!.title),
    );
  // Objectives lead with the one whose work starts earliest.
  objIds.sort((a, b) => {
    const aa = Math.min(...objToRegions.get(a)!.map((k) => arrival.get(k) ?? 0));
    const ba = Math.min(...objToRegions.get(b)!.map((k) => arrival.get(k) ?? 0));
    return aa - ba || a.localeCompare(b);
  });

  // Pre-size every goal zone (pack geometry only; positions assigned below).
  type ZoneGeom = {
    offsets: Map<string, { x: number; y: number; col: number }>;
    width: number;
    height: number;
    cols: number;
    goal: { x: number; y: number };
    result: { x: number; y: number };
  };
  const zoneOf = new Map<string, ZoneGeom>();
  for (const key of regionOrder)
    zoneOf.set(key, layoutGoalZone(regionMap.get(key)!.members));
  // Full footprint (header + pads) a zone reserves in the flow.
  const zoneFootW = (key: string) => zoneOf.get(key)!.width + 2 * CREW_ZONE_PAD;
  const zoneFootH = (key: string) =>
    CREW_ZONE_HEADER_H + zoneOf.get(key)!.height + 2 * CREW_ZONE_PAD;

  // Adaptive board width: wide enough for the widest objective to lay its goals
  // in a single left→right row when reasonable, bounded so it never runs away.
  const rowWidth = (keys: string[], pad: number) => {
    let row = 2 * pad;
    keys.forEach((k, i) => {
      row += zoneFootW(k) + (i > 0 ? CREW_ZONE_GAP_X : 0);
    });
    return row + 2 * CREW_PAD;
  };
  let widestRow = CREW_CONTENT_W_MIN;
  for (const objId of objIds)
    widestRow = Math.max(
      widestRow,
      rowWidth(objToRegions.get(objId)!, CREW_OBJ_INNER_PAD),
    );
  if (looseRegions.length > 0)
    widestRow = Math.max(widestRow, rowWidth(looseRegions, 0));
  const contentW = Math.min(
    CREW_CONTENT_W_MAX,
    Math.max(targetWidth || 0, widestRow),
  );
  const outerW = contentW - 2 * CREW_PAD;

  const objectives: CrewObjective[] = [];
  const regions: CrewRegion[] = [];
  const laneOffsets = new Map<
    string,
    Map<string, { x: number; y: number; col: number }>
  >();

  // Drop one goal zone at (zx,zy): record its frame + stash member offsets.
  const placeZone = (key: string, zx: number, zy: number) => {
    const acc = regionMap.get(key)!;
    const m = meta.get(key)!;
    const z = zoneOf.get(key)!;
    laneOffsets.set(key, z.offsets);
    // Origin of the zone's task area (same anchor the node-emit step uses below),
    // so the bookend rects land in the exact gutter the layout reserved.
    const taskOX = zx + CREW_ZONE_PAD;
    const taskOY = zy + CREW_ZONE_HEADER_H + CREW_ZONE_PAD;
    regions.push({
      id: key,
      kind: m.kind,
      title: m.title,
      subtitle: laneSubtitle(acc.members),
      x: zx,
      y: zy,
      width: z.width + 2 * CREW_ZONE_PAD,
      height: CREW_ZONE_HEADER_H + z.height + 2 * CREW_ZONE_PAD,
      headerHeight: CREW_ZONE_HEADER_H,
      stat: rollup(acc.members),
      objectiveId: m.objectiveId,
      expanded: true,
      goalBlock: {
        x: taskOX + z.goal.x,
        y: taskOY + z.goal.y,
        w: CREW_BOOKEND_W,
        h: CREW_BOOKEND_H,
      },
      resultBlock: {
        x: taskOX + z.result.x,
        y: taskOY + z.result.y,
        w: CREW_BOOKEND_W,
        h: CREW_BOOKEND_H,
      },
    });
  };

  // Flow a set of goal zones left→right inside [left, left+width], wrapping to a
  // new row when the next zone would overrun. Two-phase: first pack zones into
  // rows, then place each row with every zone VERTICALLY CENTRED in the row band.
  // Centring is what makes the bookends line up: a zone's Goal/Result block sits
  // at its own task-pack centre, so once the whole zone is centred in the row the
  // block lands at `rowTop + rowMaxFootH/2 + HEADER_H/2 − BOOKEND_H/2` — a value
  // independent of that zone's own height. Every Goal/Result in the row therefore
  // shares ONE rail, while staying connected to its own tasks. So a sequence of
  // goals reads as a clean continuous Goal→…→Result→Goal→…→Result spine instead
  // of bookends bobbing at mismatched heights. Returns the bottom Y used.
  const flowZones = (
    keys: string[],
    left: number,
    top: number,
    width: number,
  ): number => {
    // Phase 1 — greedy-wrap the zones into rows.
    const rows: string[][] = [];
    let row: string[] = [];
    let rowW = 0;
    for (const k of keys) {
      const w = zoneFootW(k);
      if (row.length > 0 && rowW + CREW_ZONE_GAP_X + w > width) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      if (row.length > 0) rowW += CREW_ZONE_GAP_X;
      row.push(k);
      rowW += w;
    }
    if (row.length > 0) rows.push(row);

    // Phase 2 — place each row, centring every zone in the row's tallest height.
    let zy = top;
    for (const r of rows) {
      let rowMaxFootH = 0;
      for (const k of r) rowMaxFootH = Math.max(rowMaxFootH, zoneFootH(k));
      let zx = left;
      for (const k of r) {
        const zoneTop = zy + Math.max(0, (rowMaxFootH - zoneFootH(k)) / 2);
        placeZone(k, zx, zoneTop);
        zx += zoneFootW(k) + CREW_ZONE_GAP_X;
      }
      zy += rowMaxFootH + CREW_ZONE_GAP_Y;
    }
    return rows.length > 0 ? zy - CREW_ZONE_GAP_Y : top;
  };

  let cursorY = CREW_PAD;

  // Each objective is a full-width band; its goal zones flow along the timeline
  // (arrival order) inside it, wrapping only on very large objectives.
  for (const objId of objIds) {
    const keys = sortRegionKeys(objToRegions.get(objId)!);
    const bandTop = cursorY;
    const innerLeft = CREW_PAD + CREW_OBJ_INNER_PAD;
    const innerWidth = outerW - 2 * CREW_OBJ_INNER_PAD;
    const zonesTop = bandTop + CREW_OBJ_HEADER_H + CREW_OBJ_INNER_PAD;
    const zonesBottom = flowZones(keys, innerLeft, zonesTop, innerWidth);
    const bandHeight = zonesBottom + CREW_OBJ_INNER_PAD - bandTop;
    const members = keys.flatMap((k) => regionMap.get(k)!.members);
    objectives.push({
      id: objId,
      title: objId.slice(objId.indexOf(":") + 1).trim() || "Objective",
      x: CREW_PAD,
      y: bandTop,
      width: outerW,
      height: bandHeight,
      headerHeight: CREW_OBJ_HEADER_H,
      regionCount: keys.length,
      stat: rollup(members),
    });
    cursorY = bandTop + bandHeight + CREW_OBJ_GAP_Y;
  }

  // Goals with no objective (and untagged connected flows) flow as standalone
  // zones across the board below the objective bands — no band frame.
  if (looseRegions.length > 0) {
    const keys = sortRegionKeys(looseRegions);
    const bottom = flowZones(keys, CREW_PAD, cursorY, outerW);
    cursorY = bottom + CREW_PAD;
  }

  // Emit task nodes for every goal zone at absolute pixels.
  for (const r of regions) {
    const acc = regionMap.get(r.id)!;
    const offs = laneOffsets.get(r.id)!;
    const ox = r.x + CREW_ZONE_PAD;
    const oy = r.y + CREW_ZONE_HEADER_H + CREW_ZONE_PAD;
    for (const m of acc.members) {
      const off = offs.get(m.task.id);
      if (!off) continue;
      nodes.push({
        id: m.task.id,
        title: m.task.title,
        status: m.status,
        priority: m.task.priority,
        agentKind: m.task.agent_kind ?? null,
        col: off.col,
        free: false,
        regionId: r.id,
        clusterId: null,
        story: storyFor(m, byId, off.col === 0, boardSteps),
        assignee: m.task.assignee?.trim() || null,
        waitingCount: waitingCount.get(m.task.id) ?? 0,
        unblockCount: unblockCount.get(m.task.id) ?? 0,
        x: ox + off.x,
        y: oy + off.y,
      });
    }
  }

  // Goal↔goal interconnections — one faint connector per pair of goal zones
  // joined by a cross-goal task dependency (deduped, NOT per task arrow). Empty
  // when goals are self-contained, which is the honest common case.
  const regionEdges: CrewGraphEdge[] = [];
  const regionKeySet = new Set(regions.map((r) => r.id));
  const seenRegionEdge = new Set<string>();
  for (const e of edges) {
    const ra = regionKeyOf(e.from);
    const rb = regionKeyOf(e.to);
    if (!ra || !rb || ra === rb) continue;
    if (!regionKeySet.has(ra) || !regionKeySet.has(rb)) continue;
    const k = `${ra}\u0000${rb}`;
    if (seenRegionEdge.has(k)) continue;
    seenRegionEdge.add(k);
    regionEdges.push({ from: ra, to: rb });
  }

  const connectedBottom = regions.length > 0 ? cursorY : 0;
  const connectedCount = regions.reduce((n, r) => n + r.stat.total, 0);

  // ── The un-ordered pile: truly loose tasks (no goal, no objective) ──────
  const freeLabeled = looseLabeled;
  const freeIds = new Set(freeLabeled.map((l) => l.task.id));

  const headerIds = new Set<string>();
  for (const l of freeLabeled) {
    const p = l.task.parent_task_id;
    if (p && p !== l.task.id && freeIds.has(p)) headerIds.add(p);
  }

  type ClusterAccum = {
    id: string;
    kind: CrewCluster["kind"];
    title: string;
    children: Labeled[];
  };
  const clusterMap = new Map<string, ClusterAccum>();
  const clusterOrder: string[] = [];
  const bucket = (
    id: string,
    kind: CrewCluster["kind"],
    title: string,
    l: Labeled,
  ) => {
    let acc = clusterMap.get(id);
    if (!acc) {
      acc = { id, kind, title, children: [] };
      clusterMap.set(id, acc);
      clusterOrder.push(id);
    }
    acc.children.push(l);
  };
  for (const l of freeLabeled) {
    if (headerIds.has(l.task.id)) continue;
    const p = l.task.parent_task_id;
    if (p && headerIds.has(p)) {
      bucket(`epic:${p}`, "epic", byId.get(p)?.task.title ?? "Epic", l);
      continue;
    }
    const sprint =
      dashTagValue(l.task, "sprint-") ?? tagValue(l.task, "sprint:");
    if (sprint) {
      bucket(`sprint:${sprint.toLowerCase()}`, "sprint", `Sprint ${sprint}`, l);
      continue;
    }
    // A task that belongs to a named crew groups under that crew rather than
    // the Unsorted pile — the fix for a crew-filed task landing "loose". The
    // default "main" crew is not a home (it's just "no crew set"), so those
    // still fall through to Unsorted.
    const crew = crewOf(l.task);
    if (crew !== "main") {
      bucket(`crew:${crew}`, "crew", `${crew} crew`, l);
      continue;
    }
    bucket("unsorted", "unsorted", "Unsorted", l);
  }

  const accums = clusterOrder.map((id) => clusterMap.get(id)!);
  const kindRank: Record<CrewCluster["kind"], number> = {
    epic: 0,
    sprint: 1,
    crew: 2,
    unsorted: 3,
  };
  accums.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      (a.kind === "epic" ? b.children.length - a.children.length : 0) ||
      a.title.localeCompare(b.title),
  );

  const sectionTop =
    accums.length > 0
      ? connectedBottom > 0
        ? connectedBottom + CREW_SECTION_GAP
        : CREW_PAD
      : null;
  const innerCols = Math.max(
    1,
    Math.floor(
      (outerW - 2 * CREW_CLUSTER_INNER_PAD + CREW_GRID_GAP_X) /
        (CREW_NODE_W + CREW_GRID_GAP_X),
    ),
  );

  const clusters: CrewCluster[] = [];
  let cy = sectionTop ?? 0;
  for (const acc of accums) {
    const isOpen = expanded.has(acc.id);
    const stat = rollup(acc.children);
    let boxH = CREW_CLUSTER_HEADER_H;
    if (isOpen && acc.children.length > 0) {
      const kids = [...acc.children].sort(byStatusThenPriority);
      const rows = Math.ceil(kids.length / innerCols);
      kids.forEach((l, i) => {
        const r = Math.floor(i / innerCols);
        const cc = i % innerCols;
        nodes.push({
          id: l.task.id,
          title: l.task.title,
          status: l.status,
          priority: l.task.priority,
          agentKind: l.task.agent_kind ?? null,
          col: cc,
          free: true,
          regionId: null,
          clusterId: acc.id,
          story: storyFor(l, byId, false, boardSteps),
          assignee: l.task.assignee?.trim() || null,
          waitingCount: waitingCount.get(l.task.id) ?? 0,
          unblockCount: unblockCount.get(l.task.id) ?? 0,
          x:
            CREW_PAD +
            CREW_CLUSTER_INNER_PAD +
            cc * (CREW_NODE_W + CREW_GRID_GAP_X),
          y: cy + CREW_CLUSTER_HEADER_H + r * (CREW_NODE_H + CREW_ROW_GAP),
        });
      });
      boxH =
        CREW_CLUSTER_HEADER_H +
        rows * CREW_NODE_H +
        (rows - 1) * CREW_ROW_GAP +
        CREW_CLUSTER_INNER_PAD;
    }
    clusters.push({
      id: acc.id,
      kind: acc.kind,
      title: acc.title,
      x: CREW_PAD,
      y: cy,
      width: outerW,
      height: boxH,
      headerHeight: CREW_CLUSTER_HEADER_H,
      expanded: isOpen,
      stat,
    });
    cy += boxH + CREW_CLUSTER_GAP;
  }

  const sectionBottom =
    sectionTop !== null && clusters.length > 0
      ? cy - CREW_CLUSTER_GAP + CREW_PAD
      : 0;

  const width = contentW;
  const height = Math.max(connectedBottom, sectionBottom, CREW_PAD);

  return {
    nodes,
    edges,
    regionEdges,
    width,
    height,
    regions,
    objectives,
    clusters,
    gridStartY: sectionTop,
    freeCount: freeLabeled.length,
    connectedCount,
  };
}

/** The WHOLE chain a selected task belongs to — every step it ultimately waits
 *  on (back to the roots) AND everything that ultimately waits on it (forward to
 *  the ends), not just its immediate neighbours. Returned as the set of node ids
 *  and the indices of edges along that chain, so the canvas can light the full
 *  path through the flow when you pick one box. Pure + cycle-safe. */
export type CrewRelatedChain = {
  nodes: Set<string>;
  edges: Set<number>;
};

export function computeRelatedChain(
  layout: CrewGraphLayout,
  selectedId: string | null | undefined,
): CrewRelatedChain {
  const nodes = new Set<string>();
  const edges = new Set<number>();
  if (!selectedId) return { nodes, edges };
  const present = new Set(layout.nodes.map((n) => n.id));
  if (!present.has(selectedId)) return { nodes, edges };
  nodes.add(selectedId);

  const forward = new Map<string, Array<{ to: string; ei: number }>>();
  const backward = new Map<string, Array<{ to: string; ei: number }>>();
  layout.edges.forEach((e, ei) => {
    (forward.get(e.from) ?? forward.set(e.from, []).get(e.from)!).push({
      to: e.to,
      ei,
    });
    (backward.get(e.to) ?? backward.set(e.to, []).get(e.to)!).push({
      to: e.from,
      ei,
    });
  });

  const flood = (adj: Map<string, Array<{ to: string; ei: number }>>) => {
    const stack = [selectedId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const { to, ei } of adj.get(cur) ?? []) {
        edges.add(ei);
        if (!nodes.has(to)) {
          nodes.add(to);
          stack.push(to);
        }
      }
    }
  };
  flood(forward);
  flood(backward);
  return { nodes, edges };
}
