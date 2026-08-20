// What a task's status is called — one vocabulary, for the whole board.
//
// Seven places named these same four states, and they did not agree on how to
// write two of them:
//
//                                          in_progress    in_review
//   ui/statusChip  TASK_STATE_CHIP         In progress    In review
//   taskColumns    TASK_COLUMNS            In Progress    In Review
//   taskColumns    TASK_STATUS_LABEL       In Progress    In Review
//   TasksFilterBar STATUS_LABEL            In Progress    In Review
//   TaskDetailSidePanel STATUS_OPTIONS     In Progress    In Review
//   CreateTaskWizard STATUS_OPTS           In progress    In review
//   TaskDetailPane (inline)                in progress    in review
//
// Two of those sat ten lines apart in the same file. The last one wasn't a
// table at all — it printed `task.status.replace(/_/g, " ")`, which is the
// database column with its underscores swapped for spaces, shown to whoever
// opened the task.
//
// And the one table that looks like the shared home, TASK_STATE_CHIP, had its
// labels read by nobody: all three call sites took `.tone` for the colour and
// then supplied their own word. A shared table half-used is not a shared
// table — it is a fourth opinion with better placement.
//
// Sentence case wins. It is what the two vocabularies this app landed most
// recently already use — "Not yet" and "Not checked" in lib/goalVerdict,
// "Needs you" and "Queued" in lib/workState — and it is what someone who does
// not write software would type. Title Case On Every Word is a habit from
// column headings, and these are not only column headings: the same string is
// a lane header, a chip on a card inside that lane, a dropdown row, and a
// filter entry. It has to read as a sentence in at least three of those.
//
// (Plane, which this board's layout follows, seeds its default states in Title
// Case. That is Plane's seed data rather than its type ramp, and it loses to
// our own two live vocabularies.)

import type { TaskStatus } from "./api";

/** The tone a status wears on a chip. A subset of ui/statusChip's `ChipTone`,
 *  named here rather than imported so this module doesn't reach up into the
 *  component layer — that direction of dependency is how the copies started. */
export type TaskStatusTone = "neutral" | "green" | "amber" | "blue";

export type TaskStatusSpec = {
  /** The word on a lane header, a chip, a dropdown row, a filter entry. */
  label: string;
  tone: TaskStatusTone;
};

export const TASK_STATUS: Record<TaskStatus, TaskStatusSpec> = {
  backlog: { label: "Backlog", tone: "neutral" },
  in_progress: { label: "In progress", tone: "blue" },
  in_review: { label: "In review", tone: "amber" },
  done: { label: "Done", tone: "green" },
};

/** The four canonical statuses in pipeline order. Board lanes render
 *  left→right in this order; list groups render top→bottom in it. */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
];

/** The pipeline as `{ id, label }` rows — the shape the lanes, the status
 *  dropdown and the detail panel all wanted, each of which was writing it out
 *  by hand. */
export const TASK_STATUS_OPTIONS: { id: TaskStatus; label: string }[] =
  TASK_STATUS_ORDER.map((id) => ({ id, label: TASK_STATUS[id].label }));

/** Plain-language name for a status id, for anywhere holding an id but not a
 *  column — a card's tooltip, the peek's chip. Falls back to Backlog rather
 *  than printing the raw enum, which is what the detail pane used to do. */
export function taskStatusLabel(status: TaskStatus): string {
  return (TASK_STATUS[status] ?? TASK_STATUS.backlog).label;
}
