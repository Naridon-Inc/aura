// Module-level shared store for the Tasks workpane filters. Used so the
// app-level TasksSidebar (mounted in the second-rail slot when Tasks is
// the active workpane) can drive the same filter state the TasksBoard
// renders against. Pattern mirrors the InboxPane `_activeFilter` shared
// store — neither side needs a provider, both subscribe via
// `useSyncExternalStore`.
//
// We deliberately do not put this on the editorStore zustand store: the
// Tasks board has its own internal filter UI (TasksFilterBar) that
// already works against local state. The shared store only carries the
// "primary bucket" pick from the sidebar + the cycle / module routing
// selection so the sidebar can drive the same surface without the
// board having to know it exists.

import { useSyncExternalStore } from "react";
import type { TaskViewFilters } from "./api";

/** A slice of the loop graph picked in the rail — a goal, or a crew.
 *
 *  Two fields because the same pick has to be legible to both halves of this
 *  place. `id` is the loop graph's own handle (a goal slug, a crew id), which
 *  is what the crew views and the runner scope by. `boardTaskIds` is that same
 *  slice said in the board's vocabulary: the cards its nodes were projected
 *  from, resolved once by the rail — the side that already holds the loop
 *  view — so List and Board never have to read the crew graph to answer "which
 *  of my cards are in this?".
 *
 *  Empty `boardTaskIds` is a real answer, not a missing one: work authored
 *  straight into the graph has no card behind it, so narrowing the board to
 *  that slice honestly leaves nothing. */
export type RailScope = {
  id: string;
  boardTaskIds: string[];
};

export type TasksSharedFilters = {
  /** The filter slice owned by the sidebar. Merged into the board's
   *  local TasksFilterBar slice when the board renders — so chips in
   *  TasksFilterBar still take precedence (priority, labels, agent,
   *  search), while the sidebar owns the broad bucket. */
  sidebar: TaskViewFilters;
  /** Selected cycle id from the sidebar Cycles section. `null` = no
   *  cycle restriction. */
  cycleId: string | null;
  /** Selected module id from the sidebar Modules section. `null` = no
   *  module restriction. */
  moduleId: string | null;
  /** Selected goal from the rail's Goals group. `null` = every goal. `id` is
   *  the goal slug.
   *
   *  Goals and crews are in here rather than in a store of their own because
   *  picking one is the same act as picking a status or a sprint: choosing
   *  which slice of the work every drawing of it shows. One rail, one
   *  selection, whichever lens happens to be mounted. */
  goal: RailScope | null;
  /** Selected crew from the rail's Crews group. `null` = all of them. `id`
   *  matches `LoopTask.crew_id`, which is what the runner scopes on. */
  crew: RailScope | null;
  /** Which goal each board card belongs to — card id → the goal's plain name.
   *
   *  This is how the Plan view came into the list. The plan drew goals with
   *  their tasks underneath; a row can say the same thing with a tag, but only
   *  if it can answer "which goal is this in?", and the answer lives in the
   *  loop graph, which the list has never read and shouldn't have to. The rail
   *  already holds that graph — it lists the goals off it — so it resolves the
   *  join once, here, and every drawing of a task can wear it.
   *
   *  Empty for a project that has never planned a goal, which is a list with no
   *  goal tags on it rather than a missing feature. */
  goalOfTask: Record<string, string>;
};

let _state: TasksSharedFilters = {
  sidebar: {},
  cycleId: null,
  moduleId: null,
  goal: null,
  crew: null,
  goalOfTask: {},
};
const _subs = new Set<() => void>();

function emit() {
  for (const fn of _subs) fn();
}

export function getTasksSharedFilters(): TasksSharedFilters {
  return _state;
}

export function setTasksSharedSidebar(next: TaskViewFilters) {
  _state = { ..._state, sidebar: next };
  emit();
}

export function setTasksSharedCycleId(id: string | null) {
  _state = { ..._state, cycleId: id };
  emit();
}

export function setTasksSharedModuleId(id: string | null) {
  _state = { ..._state, moduleId: id };
  emit();
}

export function setTasksSharedGoal(goal: RailScope | null) {
  _state = { ..._state, goal };
  emit();
}

export function setTasksSharedCrew(crew: RailScope | null) {
  _state = { ..._state, crew };
  emit();
}

/** Publish the card → goal join, resolved by the rail off the loop graph.
 *
 *  Identity-stable when nothing moved: this is re-derived on every 30s poll of
 *  a graph that usually hasn't changed, and handing out a new object each time
 *  would re-render every row in the list for no news. */
export function setTasksGoalIndex(goalOfTask: Record<string, string>) {
  const prev = _state.goalOfTask;
  const keys = Object.keys(goalOfTask);
  if (
    keys.length === Object.keys(prev).length &&
    keys.every((k) => prev[k] === goalOfTask[k])
  ) {
    return;
  }
  _state = { ..._state, goalOfTask };
  emit();
}

/** The board cards the rail's loop picks narrow to — the intersection of
 *  whichever of goal and crew are set, or `null` when neither is.
 *
 *  Intersection because both are narrowings and the rail lights both rows:
 *  "this goal" AND "this crew" is the only reading of two lit rows that
 *  matches what the loop views show, which apply the two scopes in series. */
export function railBoardTaskIds(
  state: TasksSharedFilters,
): Set<string> | null {
  const { goal, crew } = state;
  if (!goal && !crew) return null;
  if (goal && !crew) return new Set(goal.boardTaskIds);
  if (crew && !goal) return new Set(crew.boardTaskIds);
  const inCrew = new Set(crew!.boardTaskIds);
  return new Set(goal!.boardTaskIds.filter((id) => inCrew.has(id)));
}

export function clearTasksSharedFilters() {
  // The goal index deliberately survives. It is not a narrowing — it is a fact
  // about the work, read off the loop graph — and clearing it here would strip
  // the goal tag off every row for the thirty seconds until the rail's next
  // poll, on a button whose whole promise is "show me everything".
  _state = {
    sidebar: {},
    cycleId: null,
    moduleId: null,
    goal: null,
    crew: null,
    goalOfTask: _state.goalOfTask,
  };
  emit();
}

const _initial: TasksSharedFilters = _state;

export function useTasksSharedFilters(): TasksSharedFilters {
  return useSyncExternalStore(
    (cb) => {
      _subs.add(cb);
      return () => _subs.delete(cb);
    },
    () => _state,
    () => _initial,
  );
}
