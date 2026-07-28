// crewQueue — the pure math behind the honest Queue view. Crew is an autonomous
// loop: you hand it a pile of tasks and it works them on its own, highest
// priority first. Almost always that pile is FLAT — hundreds of independent
// tasks with no "waiting on" links between them. So the Queue is not a graph;
// it's a priority worklist. This module turns the flat `ready_view` into the
// three things a vibecoder actually needs to read at a glance:
//
//   • the SHAPE of the pile  → `priorityBreakdown` (a tiny stacked bar)
//   • what runs NEXT, in order → `crewPickOrder` (priority, then oldest-first)
//   • the rest, grouped       → `groupByPriority` (collapsed by default)
//
// A real dependency flowchart is drawn elsewhere, and only when edges actually
// exist (`crewHasDependencyLinks`) — never forced onto an edge-less pile.
//
// Pure + deterministic (no Date/random) so it's unit-testable and renders the
// same every time.

import type { LoopTask, ReadyViewDto } from "../../../lib/api";

export type PriorityKey = "critical" | "high" | "medium" | "low";

// Fixed display order + the one palette the bar, the group headers and the
// chips all agree on. Red = critical, amber = high, arctic-blue = medium,
// muted = low. (Matches crewShared's PRIORITY_TONE so a chip and its bar
// segment never disagree.)
export const PRIORITY_META: Record<
  PriorityKey,
  { label: string; color: string; rank: number }
> = {
  critical: { label: "Critical", color: "var(--color-red)", rank: 0 },
  high: { label: "High", color: "var(--color-amber)", rank: 1 },
  medium: { label: "Medium", color: "var(--color-accent)", rank: 2 },
  low: { label: "Low", color: "var(--color-text-5)", rank: 3 },
};

const PRIORITY_KEYS: PriorityKey[] = ["critical", "high", "medium", "low"];

/** Coerce any priority string to one of the four buckets (default medium). */
export function priorityKey(priority: string | null | undefined): PriorityKey {
  const p = (priority ?? "").toLowerCase();
  if (p === "critical" || p === "high" || p === "medium" || p === "low")
    return p;
  return "medium";
}

function rankOf(task: LoopTask): number {
  return PRIORITY_META[priorityKey(task.priority)].rank;
}

/** The order the crew will actually take ready tasks: highest priority first,
 *  then oldest-queued first (FIFO within a priority), then title for a stable
 *  tie-break. This is our honest best read of "what runs next". */
export function crewPickOrder(ready: LoopTask[]): LoopTask[] {
  return [...ready].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      (a.created_at ?? 0) - (b.created_at ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

export type PriorityBucket = {
  key: PriorityKey;
  label: string;
  color: string;
  count: number;
};

/** Per-priority counts in fixed order, omitting empties — drives the stacked
 *  "shape of the pile" bar and its legend. */
export function priorityBreakdown(ready: LoopTask[]): PriorityBucket[] {
  const counts = new Map<PriorityKey, number>();
  for (const t of ready) {
    const k = priorityKey(t.priority);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return PRIORITY_KEYS.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => ({
    key: k,
    label: PRIORITY_META[k].label,
    color: PRIORITY_META[k].color,
    count: counts.get(k) ?? 0,
  }));
}

export type PriorityGroup = {
  key: PriorityKey;
  label: string;
  color: string;
  tasks: LoopTask[];
};

/** Ready tasks split into priority groups (fixed order, oldest-first within),
 *  empties dropped. Used by the collapsed "all ready" disclosure. */
export function groupByPriority(ready: LoopTask[]): PriorityGroup[] {
  const groups: PriorityGroup[] = [];
  for (const k of PRIORITY_KEYS) {
    const tasks = ready
      .filter((t) => priorityKey(t.priority) === k)
      .sort(
        (a, b) =>
          (a.created_at ?? 0) - (b.created_at ?? 0) ||
          a.title.localeCompare(b.title),
      );
    if (tasks.length > 0)
      groups.push({
        key: k,
        label: PRIORITY_META[k].label,
        color: PRIORITY_META[k].color,
        tasks,
      });
  }
  return groups;
}

/** True when at least one task in view waits on another task in view — i.e.
 *  there's a real flowchart to draw. When false, the Queue is a flat worklist
 *  and no dependency map is shown at all. */
export function crewHasDependencyLinks(view: ReadyViewDto): boolean {
  const ids = new Set<string>();
  for (const t of allTasks(view)) ids.add(t.id);
  for (const t of allTasks(view)) {
    for (const dep of t.depends_on ?? []) if (ids.has(dep)) return true;
  }
  return false;
}

/** Flatten every lane to one task list (working + ready + blocked + done +
 *  other). Order doesn't matter to callers that only need membership/ids. */
export function allTasks(view: ReadyViewDto): LoopTask[] {
  return [
    ...view.working,
    ...view.ready,
    ...view.blocked.map((b) => b.task),
    ...view.done,
    ...view.other,
  ];
}

/** A `ready_view` reduced to ONLY the tasks that participate in an in-view
 *  "waiting on" link, so the dependency map draws the flowchart alone — never
 *  the hundreds of unrelated independent tasks around it. Lanes the connected
 *  nodes keep their own status; non-participants are dropped from every lane. */
export function connectedView(view: ReadyViewDto): ReadyViewDto {
  const all = allTasks(view);
  const ids = new Set(all.map((t) => t.id));
  const connected = new Set<string>();
  for (const t of all) {
    for (const dep of t.depends_on ?? []) {
      if (ids.has(dep)) {
        connected.add(dep);
        connected.add(t.id);
      }
    }
  }
  const keep = (t: LoopTask) => connected.has(t.id);
  return {
    ...view,
    working: view.working.filter(keep),
    ready: view.ready.filter(keep),
    blocked: view.blocked.filter((b) => connected.has(b.task.id)),
    done: view.done.filter(keep),
    other: view.other.filter(keep),
  };
}
