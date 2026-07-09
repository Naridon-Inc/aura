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
};

let _state: TasksSharedFilters = {
  sidebar: {},
  cycleId: null,
  moduleId: null,
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

export function clearTasksSharedFilters() {
  _state = { sidebar: {}, cycleId: null, moduleId: null };
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
