// Tasks — one place for the work, and three drawings of it.
//
// This app shipped two boards. "Tasks" read `.aura/tasks/`: the backlog, the
// same store the CLI's `aura_tasks_list` and the phone read. "Mission Control"
// read the crew's ready_view: the dependency graph agents actually run. Two
// rail destinations, two headers, two vocabularies — and both of them drawing
// lanes of cards, so "why are there two of these?" was a fair question with no
// good answer.
//
// They were never two stores. A crew node carries `board_task_id` —
// "provenance back to the board card this node was projected from"
// (lib/api.ts) — written by `aura loop run` and already joined by the task
// detail's crew activity section. Mission Control was a PROJECTION of the
// board, drawn on its own page under a name that made it sound like a separate
// system.
//
// So there is one destination, Tasks, and the drawings are lenses of it. Both
// surfaces render the same OPTIONS through the same tab strip
// (components/tasks/WorkLensTabs). The strip is continuous across the switch —
// picking a lens the other surface owns is a navigation, not a different
// control living somewhere else.
//
// Three cells, because two of the five this once carried were the same records
// drawn again.
//
//   Plan was the crew's tasks with their goal above them, in dependency order.
//   That is a GROUPING of the list, not a second product: every row wears the
//   goal it belongs to as a tag, the rail lists the goals and narrows to one,
//   and Display's "group by goal" cuts the list exactly the way the plan drew
//   it. So the list absorbed it whole, and the cell went.
//
//   Sprint was a whole second product wearing a lens's clothes: a burndown
//   chart, a capacity rollup, a velocity sparkline, an at-risk heuristic, a
//   pull-into-sprint drawer and a close-the-sprint ceremony — none of which is
//   a way of LOOKING at the work, which is what the other cells offer. A sprint
//   is a slice of the backlog, and slicing the backlog is what the rail already
//   does: pick a sprint there and List and Board answer for it. Its two
//   lifecycle doors moved to the rail's Sprints group.
//
// What is left is three genuinely different pictures. List groups the work and
// reads top to bottom. Board lanes it and reads across — the same records, but
// "what is in review right now" is one glance instead of a scroll. Graph is
// nodes and edges: what feeds what, which neither of the other two can draw.
//
// Mirrors lib/placeRoute and components/trace/traceRoute for the same reason
// those exist: the callers are deep — a header strip, a nav row, a deep link —
// and threading a router into components that only draw would put navigation
// in the props of things that have no business knowing about it.

import { KanbanSquare, List, Network } from "lucide-react";

import type { BoardLayoutOption } from "../components/board/BoardLayoutSwitch";

/** How you're looking at the work. The first two are the board's own drawings;
 *  the last is the crew's. */
export type WorkLens = "list" | "board" | "graph";

/** The lenses the crew surface owns. Everything else is the task board. One
 *  predicate, so the host and both surfaces agree on which is which. */
export function isCrewLens(lens: WorkLens): boolean {
  return lens === "graph";
}

/** The task board's internal view for a board lens. A crew lens never reaches
 *  the board, so it falls back to the drawing most people want. */
export function taskViewFor(lens: WorkLens): "list" | "board" {
  return lens === "board" ? "board" : "list";
}

/** The one option list. Both headers render this, so the strip a reader sees
 *  on the Board lens is the strip they see on the Graph lens — same cells,
 *  same order, same widths — and the surface swapping underneath is not
 *  something they have to notice. */
export const WORK_LENSES: readonly BoardLayoutOption<WorkLens>[] = [
  {
    value: "list",
    label: "List",
    icon: List,
    hint: "See the work as one grouped list",
  },
  {
    value: "board",
    label: "Board",
    icon: KanbanSquare,
    hint: "See the work as lanes you can scan across",
  },
  {
    value: "graph",
    label: "Graph",
    icon: Network,
    hint: "See what feeds what. The dependency map",
  },
];

/** Every lens on the strip, in strip order. Exported so the guard below and
 *  the tests over it read the same list the header draws — a lens that is
 *  offered but not accepted (or accepted but not offered) is the failure this
 *  single source exists to make impossible. */
export const WORK_LENS_VALUES: readonly WorkLens[] = WORK_LENSES.map(
  (o) => o.value,
);

const KEY = "aura.work.lens";

/** The lens the destination reopens on: the work itself, as a list.
 *
 *  The membership test is also the migration. Anyone whose last lens was
 *  `plan`, `sprint` or `map` has a string in storage that is no longer a lens,
 *  and reopens on the list rather than on a cell that isn't there. */
export function readWorkLens(): WorkLens {
  try {
    const raw = localStorage.getItem(KEY) as WorkLens | null;
    return raw && WORK_LENS_VALUES.includes(raw) ? raw : "list";
  } catch {
    return "list";
  }
}

export function writeWorkLens(lens: WorkLens): void {
  try {
    localStorage.setItem(KEY, lens);
  } catch {
    /* private mode — the choice just won't outlive the session */
  }
}

export const WORK_GO_EVENT = "aura:work:go";

/** Ask the app for the work. With no lens it opens on the one you left, which
 *  is what a nav row means; with a lens it opens on that drawing, which is
 *  what a header cell means. Whoever owns the page listens. */
export function goToWork(lens?: WorkLens): void {
  window.dispatchEvent(new CustomEvent(WORK_GO_EVENT, { detail: lens }));
}
