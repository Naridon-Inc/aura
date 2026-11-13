// Task-side adapters onto the shared status glyphs.
//
// Statuses draw with the dashboard's lifecycle glyphs and priority with the
// board's three-bar signal. This is the only place the task domain is mapped
// onto them, so a status can never draw one shape in the list and another on
// the board.

import type { JSX } from "react";

import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from "./taskColumns";
import { TASK_STATUS_ORDER } from "../../lib/taskStatus";
import { WorkspaceStageIcon, type WorkspaceStage } from "../ui/workspace-preview-card";
import {
  TaskPriorityGlyph,
  TaskStatusBadge,
  TaskStatusMenu,
  type TaskStatusOption,
} from "../ui/tasks-status";
import type {
  TaskPriority,
  TaskState,
  TaskStatus,
  TaskViewGroupBy,
} from "../../lib/api";

/** The lifecycle glyph each pipeline status wears. The board's four statuses
 *  are the dashboard's first four stages, in the same order. */
const STATUS_STAGE: Record<TaskStatus, WorkspaceStage> = {
  backlog: "backlog",
  in_progress: "in-progress",
  in_review: "in-review",
  done: "done",
};

/** A named state's glyph comes from the group it belongs to, so a renamed
 *  "Doing" still reads as work in flight and a cancelled card reads as
 *  cancelled rather than done. */
const GROUP_STAGE: Record<string, WorkspaceStage> = {
  backlog: "backlog",
  unstarted: "backlog",
  started: "in-progress",
  completed: "done",
  cancelled: "canceled",
};

export function stageForStatus(status: TaskStatus): WorkspaceStage {
  return STATUS_STAGE[status] ?? "backlog";
}

/** The glyph stage for a state bucket ("started", "completed", …). */
export function stageForGroup(group: string): WorkspaceStage {
  return GROUP_STAGE[group] ?? "backlog";
}

export function stageForTask(
  status: TaskStatus,
  state: TaskState | null | undefined,
): WorkspaceStage {
  if (state && !state.is_default) return GROUP_STAGE[state.group] ?? stageForStatus(status);
  if (state?.group === "cancelled") return "canceled";
  return stageForStatus(status);
}

/** The status glyph shown in column headers, list section headers and on
 *  every card and row. */
export function TaskStateRing({ statusId }: { statusId: TaskStatus }): JSX.Element {
  return <WorkspaceStageIcon stage={stageForStatus(statusId)} />;
}

/** Whether a card or row should name its status in words.
 *
 *  Grouped by status, the section header above already says it. Grouped any
 *  other way nothing does. A state the user renamed always shows, because no
 *  header carries that name. */
export function shouldShowStateChip(
  state: TaskState | null | undefined,
  groupBy: TaskViewGroupBy,
): boolean {
  if (state && !state.is_default) return true;
  return groupBy !== "status";
}

/** The status a card or a row names: the user's own state name when they
 *  created or renamed one, the pipeline's word otherwise. A seeded state
 *  ("Todo", "Cancelled") defers to the pipeline so a card never contradicts
 *  the column it sits in. */
export function TaskStateChip({
  state,
  status,
}: {
  state: TaskState | null | undefined;
  status: TaskStatus;
}): JSX.Element {
  if (state && !state.is_default) {
    return (
      <TaskStatusBadge
        stage={stageForTask(status, state)}
        label={state.name}
        color={state.color || undefined}
      />
    );
  }
  return (
    <TaskStatusBadge
      stage={stageForStatus(status)}
      label={TASK_STATUS_LABEL[status] ?? TASK_STATUS_LABEL.backlog}
    />
  );
}

/** The pipeline's four statuses as menu options. A state the user created is
 *  set from the task's detail, where the full catalog lives. */
export const TASK_STATUS_MENU: TaskStatusOption[] = TASK_STATUS_ORDER.map((id) => ({
  id,
  label: TASK_STATUS_LABEL[id],
  stage: stageForStatus(id),
}));

/** The status glyph on a row or a card, and the way to change it. Without
 *  `onStatus` it is only the glyph. With `named`, the trigger carries the
 *  status's name as well. */
export function TaskStatusTag({
  state,
  status,
  onStatus,
  named = false,
}: {
  state: TaskState | null | undefined;
  status: TaskStatus;
  onStatus?: (next: TaskStatus) => void;
  named?: boolean;
}): JSX.Element {
  const face = named ? (
    <TaskStateChip state={state} status={status} />
  ) : (
    <span title={state && !state.is_default ? state.name : TASK_STATUS_LABEL[status]}>
      <WorkspaceStageIcon stage={stageForTask(status, state)} />
    </span>
  );
  if (!onStatus) return face;
  return (
    <TaskStatusMenu
      value={status}
      options={TASK_STATUS_MENU}
      onChange={(id) => onStatus(id as TaskStatus)}
      label={`Status: ${TASK_STATUS_LABEL[status]}. Change it`}
    >
      {face}
    </TaskStatusMenu>
  );
}

/** Priority as a 0–4 level for the shared three-bar signal. */
const PRIORITY_LEVEL: Record<TaskPriority, 0 | 1 | 2 | 3 | 4> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

// Plain names for priorities live with the other plain task names, in a
// module tests and pure helpers can load without the glyphs.
export { TASK_PRIORITY_LABEL };

export function TaskPriorityBars({
  priority,
}: {
  priority: TaskPriority;
}): JSX.Element {
  return (
    <TaskPriorityGlyph
      level={PRIORITY_LEVEL[priority] ?? 0}
      label={TASK_PRIORITY_LABEL[priority] ?? "None"}
    />
  );
}
