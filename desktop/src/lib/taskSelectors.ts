// taskSelectors.ts — AUDIT-UI-02: the one place task populations and
// counters are defined.
//
// Before this module every task surface derived its own numbers from its
// own fetch of the same tasks.json: the board header counted raw rows
// (archived included), the kanban columns counted a filtered slice, the
// left rail and right rail each counted everything, and the sprint
// done/total math was pasted verbatim in two components. Two surfaces on
// screen at once could disagree about the same repository. Every counter
// now derives through these selectors, so a number's population is a
// decision made once — here — not per-component.

import type { Task, TaskStatus } from "./api";

/** The canonical work-item population: archived rows are out of every
 *  count and every view. This was already the board kanban's rule
 *  (`!t.archived_at`); promoting it to the shared definition means the
 *  header, the rails and sprint math can no longer silently include
 *  rows the board itself hides. */
export function workItems(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.archived_at);
}

/** Per-status counts over the canonical population. Feeds the right-rail
 *  status stripe and any other status breakdown. */
export function statusCounts(tasks: Task[]): Record<TaskStatus, number> {
  const out: Record<TaskStatus, number> = {
    backlog: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const t of workItems(tasks)) out[t.status] += 1;
  return out;
}

export type SidebarBuckets = {
  all: number;
  mine: number;
  unassigned: number;
  active: number;
  overdue: number;
  backlog: number;
  in_progress: number;
  in_review: number;
  done: number;
};

/** The left-rail bucket counts (Your work / Status sections), computed
 *  over the canonical population so "All tasks" here equals the board's
 *  unfiltered item count. `todayYmd` is injectable for determinism. */
export function sidebarBuckets(
  tasks: Task[],
  currentHandle?: string | null,
  todayYmd: string = new Date().toISOString().slice(0, 10),
): SidebarBuckets {
  const out: SidebarBuckets = {
    all: 0,
    mine: 0,
    unassigned: 0,
    active: 0,
    overdue: 0,
    backlog: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const t of workItems(tasks)) {
    out.all += 1;
    if (t.status === "backlog") out.backlog += 1;
    else if (t.status === "in_progress") {
      out.in_progress += 1;
      out.active += 1;
    } else if (t.status === "in_review") {
      out.in_review += 1;
      out.active += 1;
    } else if (t.status === "done") out.done += 1;
    if (
      currentHandle &&
      (t.assignee === currentHandle || t.assignee_ids.includes(currentHandle))
    ) {
      out.mine += 1;
    }
    if (t.assignee_ids.length === 0 && !t.assignee) out.unassigned += 1;
    if (t.status !== "done" && t.due_date && t.due_date < todayYmd) {
      out.overdue += 1;
    }
  }
  return out;
}

/** Sprint membership: tasks pointed at the cycle, minus epics (container
 *  cards would double-count their children) and minus archived rows —
 *  the same population rule as everywhere else. */
export function sprintTasksOf(tasks: Task[], cycleId: string): Task[] {
  return workItems(tasks).filter(
    (t) => t.cycle_id === cycleId && !t.is_epic,
  );
}

export type SprintWorkStats = {
  /** True when every member task carries a positive estimate — the
   *  sprint is then measured in points, otherwise in task counts. */
  usePoints: boolean;
  total: number;
  done: number;
  remaining: number;
  /** 0–100, rounded; 0 when the sprint is empty. */
  pct: number;
  unit: "pts" | "tasks";
};

/** The sprint done/total math previously duplicated (identically) in
 *  TasksBoard's SprintView and in SprintProgress. Pass the output of
 *  `sprintTasksOf` so both surfaces measure the same population. */
export function sprintWorkStats(sprintTasks: Task[]): SprintWorkStats {
  const usePoints =
    sprintTasks.length > 0 &&
    sprintTasks.every(
      (t) => typeof t.estimate === "number" && t.estimate! > 0,
    );
  const total = usePoints
    ? sprintTasks.reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.length;
  const done = usePoints
    ? sprintTasks
        .filter((t) => t.status === "done")
        .reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.filter((t) => t.status === "done").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    usePoints,
    total,
    done,
    remaining: total - done,
    pct,
    unit: usePoints ? "pts" : "tasks",
  };
}
