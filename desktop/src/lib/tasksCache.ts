// tasksCache — the board's reads, coalesced. Deliberately without a window.
//
// `tasks_list` is not a file read either. It loads the board, then runs five
// heal passes over it: sequence ids, the status ↔ state_id and label ↔ label_id
// ontology mirror, first-touch of the cycle and module catalogs, and the legacy
// sprint fold — writing back to disk whenever any of them changed something.
//
// Opening Tasks mounts three surfaces that each ask for it at the same instant:
// the board, the place rail's groups, and BuildNav. Under "All projects" each
// of those fans out per project root, so a four-project scope opened the board
// with twelve of those heal passes racing each other over the same files. Add
// the task detail pane and the sprint progress pane and it is more.
//
// WHY NO FRESHNESS WINDOW. Every surface that reads the board is also a surface
// that writes to it — drag a card, assign someone, close a cycle, bulk-label a
// selection, mint a bead — across about twenty-five mutation call sites, each
// of which re-reads afterwards to show you what it did. A window here is a
// promise that nothing has changed, and here something has: it would only need
// to outlive one of those writes to show a user their own change missing, which
// is indistinguishable from the write having failed. Team manifests and session
// lists can hold an answer for a few seconds because almost nobody writes them.
// The board is written to constantly.
//
// So this collapses reads that are *in flight together* and nothing more. That
// is the actual defect — three surfaces asking one question at one instant —
// and unlike a window it cannot ever hand back a stale answer: the read still
// happens, every caller just shares the one that is already running.

import {
  api,
  type Cycle,
  type Module,
  type Task,
  type TaskLabel,
  type TaskState,
} from "./api";
import { readShared, sharedReader } from "./sharedRead";

/** Zero window: join a read already running, otherwise do a real one. See the
 *  header — the board is a surface people write to, so nothing here is allowed
 *  to be answered from memory. */
const COALESCE_ONLY = 0;

const tasks = sharedReader(
  (repoRoot: string) => api.tasksList(repoRoot),
  COALESCE_ONLY,
);
const states = sharedReader(
  (repoRoot: string) => api.taskStatesList(repoRoot),
  COALESCE_ONLY,
);
const labels = sharedReader(
  (repoRoot: string) => api.taskLabelsList(repoRoot),
  COALESCE_ONLY,
);
const cycles = sharedReader(
  (repoRoot: string) => api.tasksCyclesList(repoRoot),
  COALESCE_ONLY,
);
const modules = sharedReader(
  (repoRoot: string) => api.tasksModulesList(repoRoot),
  COALESCE_ONLY,
);

/** The repo's tasks. Rejects if the board could not be read — an empty board
 *  is a real answer and every caller already decides what a failure means. */
export function fetchTasks(repoRoot: string): Promise<Task[]> {
  return readShared(tasks, repoRoot);
}

/** The board's status columns. Read by the board, the rail and the detail pane
 *  at the same moment, and seeded on first read by the backend. */
export function fetchTaskStates(repoRoot: string): Promise<TaskState[]> {
  return readShared(states, repoRoot);
}

/** The board's label catalog — same three readers, same instant. */
export function fetchTaskLabels(repoRoot: string): Promise<TaskLabel[]> {
  return readShared(labels, repoRoot);
}

/** The project's cycles. */
export function fetchCycles(repoRoot: string): Promise<Cycle[]> {
  return readShared(cycles, repoRoot);
}

/** The project's modules. */
export function fetchModules(repoRoot: string): Promise<Module[]> {
  return readShared(modules, repoRoot);
}
