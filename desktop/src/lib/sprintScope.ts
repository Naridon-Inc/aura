// What a sprint is holding, and who can inherit it when it closes.
//
// This arithmetic used to live inside the Sprint lens, next to a burndown
// chart and a capacity rollup, which is why deleting that lens would have
// taken the two sprint acts nobody wanted deleted with it: starting a sprint
// and completing one. The numbers are what "Complete sprint" needs in order to
// tell you what you're about to freeze — delivered, carried, velocity — and
// none of them needed a dashboard to be true.
//
// So they live here, as functions over rows, and the rail's Sprints group
// calls them. Pure on purpose: no fetching, no component state, no clock. The
// one judgement call — whether a sprint is measured in story points or in
// items — is made in exactly one place (`usePoints`) so the Complete panel's
// three numbers can never disagree about the unit they're in.

import type { Cycle, Sprint, Task } from "./api";

/** The store keeps cycles; every screen a reader can see says "sprint". The
 *  legacy `Sprint` shape is what the create wizard and the complete panel
 *  speak, so the projection is here rather than copied into each caller. */
export function cycleAsSprint(cycle: Cycle): Sprint {
  return {
    id: cycle.id,
    name: cycle.name,
    start: cycle.start_date,
    end: cycle.end_date,
    goal: cycle.goal,
    active: cycle.status === "active",
    velocity: cycle.velocity ?? null,
    created_at: cycle.created_at,
    updated_at: cycle.updated_at,
  };
}

/** A sprint that has already been completed carries its frozen throughput.
 *  Nothing more can be closed, carried or delivered out of it. */
export function isCompleted(cycle: Cycle): boolean {
  return cycle.status === "completed" || cycle.velocity != null;
}

export type SprintScope = {
  /** Items in the sprint, and of those, items finished. */
  totalCount: number;
  doneCount: number;
  /** The same two in story points. Zero when the sprint isn't estimated. */
  totalPoints: number;
  donePoints: number;
  /** True only when EVERY item carries a positive estimate. A sprint where
   *  half the work is estimated cannot be honestly summed in points, so it is
   *  counted in items instead — one unit for all three numbers above. */
  usePoints: boolean;
  /** What has to go somewhere when this sprint closes. */
  carriedCount: number;
  /** What gets frozen as the sprint's velocity: delivered points when the
   *  sprint is estimated, delivered items when it isn't. */
  velocity: number;
};

/** Everything the complete-sprint flow needs to know about one sprint.
 *
 *  Measured over the sprint's own membership, never over a filtered view of
 *  it: what a sprint delivered is a fact about the sprint, and must not change
 *  because someone narrowed the rail to one assignee. Epics are excluded —
 *  they are containers for tasks, so counting both double-counts the work. */
export function sprintScope(tasks: Task[], cycleId: string): SprintScope {
  const rows = tasks.filter((t) => t.cycle_id === cycleId && !t.is_epic);
  const done = rows.filter((t) => t.status === "done");

  const usePoints =
    rows.length > 0 &&
    rows.every((t) => typeof t.estimate === "number" && t.estimate > 0);

  const points = (list: Task[]) =>
    list.reduce((sum, t) => sum + (t.estimate ?? 0), 0);

  const totalPoints = points(rows);
  const donePoints = points(done);

  return {
    totalCount: rows.length,
    doneCount: done.length,
    totalPoints,
    donePoints,
    usePoints,
    carriedCount: rows.length - done.length,
    velocity: usePoints ? donePoints : done.length,
  };
}

/** Where unfinished work can go when a sprint closes: any other sprint that
 *  hasn't itself been completed. The backlog is always available and is the
 *  panel's own default, so it isn't in this list. */
export function carryTargets(cycles: Cycle[], closingId: string): Sprint[] {
  return cycles
    .filter((c) => c.id !== closingId && !isCompleted(c))
    .map(cycleAsSprint);
}

/** What a new sprint can be planned out of: unfinished, non-epic work that
 *  isn't already in a sprint. Deliberately the whole set rather than whatever
 *  the rail is currently narrowed to — you are planning here, not browsing,
 *  and a sprint quietly planned out of a filtered subset is a sprint missing
 *  work nobody noticed was hidden. */
export function planningBacklog(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) => !t.is_epic && t.status !== "done" && !t.cycle_id,
  );
}
