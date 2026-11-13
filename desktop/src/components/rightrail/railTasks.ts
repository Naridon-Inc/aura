// What the details panel's Tasks tab shows of the board, and what a tick on
// one of its rows writes back.
//
// The panel is the library task list: a row is done, under way or not started,
// and its circle flips it between done and not done. The board says more than
// that — five state groups, custom columns, archived and cancelled rows — so
// this is the one place that folds a board row into a list row and turns a
// tick back into a board write. Pure, so it can be tested without a backend.
//
// `state_id` is the board's truth; `status` is a legacy mirror the backend
// keeps for older readers. A row is read from its state first, and a write
// names a state whenever the board's catalog has one for it, so the tick lands
// in a real column rather than in whichever column the mirror happens to map
// to.

import type { Task, TaskState, TaskStateGroup, UpdateTaskInput } from "../../lib/api";
import type { TaskItem } from "../ui/tasks";

const GROUPS: ReadonlySet<string> = new Set([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

/** The board group a task sits in: its state's group when the catalog knows
 *  the state, the state id itself when it is one of the five built-in ids, and
 *  the legacy status otherwise. */
export function railGroup(task: Task, states: ReadonlyMap<string, TaskState>): TaskStateGroup {
  const state = task.state_id ? states.get(task.state_id) : undefined;
  if (state) return state.group;
  if (task.state_id && GROUPS.has(task.state_id)) return task.state_id as TaskStateGroup;
  switch (task.status) {
    case "in_progress":
    case "in_review":
      return "started";
    case "done":
      return "completed";
    default:
      return "backlog";
  }
}

function itemStatus(group: TaskStateGroup): TaskItem["status"] {
  if (group === "completed") return "completed";
  if (group === "started") return "in_progress";
  return "pending";
}

const ORDER: Record<TaskItem["status"], number> = { in_progress: 0, pending: 1, completed: 2 };

/** The first line of a description, which is all a list row has room for. */
function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.replace(/^#+\s*/, "") : undefined;
}

/** The board as list rows: under way first, then not started, then done, each
 *  newest first. Archived and cancelled rows are not work anyone is doing, so
 *  they are left out, and so is their share of the done count. */
export function railItems(tasks: readonly Task[], states: ReadonlyMap<string, TaskState>): TaskItem[] {
  return tasks
    .filter((t) => !t.archived_at)
    .map((t) => ({ task: t, group: railGroup(t, states) }))
    .filter(({ group }) => group !== "cancelled")
    .map(({ task, group }) => ({
      item: {
        id: task.id,
        subject: task.title,
        description: firstLine(task.description ?? ""),
        status: itemStatus(group),
        owner: task.agent_assignee || task.assignee || task.assignee_ids?.[0] || undefined,
      } satisfies TaskItem,
      updated: task.updated_at,
    }))
    .sort((a, b) => ORDER[a.item.status] - ORDER[b.item.status] || b.updated.localeCompare(a.updated))
    .map(({ item }) => item);
}

/** The catalog's first state in a group, by column position. */
function firstState(states: readonly TaskState[], group: TaskStateGroup): TaskState | undefined {
  return states
    .filter((s) => s.group === group)
    .sort((a, b) => a.position - b.position)[0];
}

/** The write a tick makes. Done lands in the board's first done column; undone
 *  goes back to the first to-do column (or the backlog when the board has no
 *  to-do column), not to whatever column it was in before it was done — the
 *  board does not remember that, and guessing would move it somewhere odd. */
export function statusWrite(
  id: string,
  next: TaskItem["status"],
  states: readonly TaskState[],
): UpdateTaskInput {
  if (next === "completed") {
    const done = firstState(states, "completed");
    return done ? { id, state_id: done.id } : { id, status: "done" };
  }
  if (next === "in_progress") {
    const started = firstState(states, "started");
    return started ? { id, state_id: started.id } : { id, status: "in_progress" };
  }
  const todo = firstState(states, "unstarted") ?? firstState(states, "backlog");
  return todo ? { id, state_id: todo.id } : { id, status: "backlog" };
}

/** A task as it will read once `input` lands, so the row moves at once. */
export function appliedWrite(task: Task, input: UpdateTaskInput, states: readonly TaskState[]): Task {
  const state = input.state_id ? states.find((s) => s.id === input.state_id) : undefined;
  const status: Task["status"] =
    input.status ??
    (state?.group === "completed"
      ? "done"
      : state?.group === "started"
        ? "in_progress"
        : state
          ? "backlog"
          : task.status);
  // A status-only write leaves the old state behind; dropping it lets the row
  // be read from the status until the backend's mirror fills it back in.
  return { ...task, state_id: input.state_id ?? (input.status ? "" : task.state_id), status };
}
