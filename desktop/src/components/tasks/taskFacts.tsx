// What a task card and a task row say besides the title — the small facts,
// the one-line summary — and the menu both offer.

import type { ReactNode } from "react";
import { Bot, Clock, GitBranch, ListChecks, Tag, Users } from "lucide-react";

import type { Task, TaskLabel, TaskStatus, TaskViewDisplayProp } from "../../lib/api";
import { TASK_STATUS_ORDER } from "../../lib/taskStatus";
import { stepProgress } from "../../lib/taskSteps";
import { ContextMenuItem, ContextMenuSeparator } from "../ui/context-menu";
import { TaskFact, type TaskOpenModifiers } from "../ui/tasks-board";
import { TASK_STATUS_LABEL, formatDueDate, isOverdue } from "./taskColumns";

/** The first line of a description, without markdown markers — the card's
 *  one-line summary. */
export function taskSummary(description: string): string | undefined {
  for (const raw of description.split("\n")) {
    const line = raw.replace(/^[#>*\-\s`]+/, "").replace(/[*_`]/g, "").trim();
    if (line) return line;
  }
  return undefined;
}

/** The small facts a card or a row carries, each only when its display
 *  property is on and it has something true to say. */
export function cardFacts(
  task: Task,
  props: Set<TaskViewDisplayProp>,
  taskLabels: TaskLabel[],
  childCount: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  if (props.has("agent") && task.agent_assignee) {
    out.push(
      <TaskFact key="agent" icon={<Bot />} title={`Agent: ${task.agent_assignee}`}>
        {task.agent_assignee}
      </TaskFact>,
    );
  }
  if (props.has("due") && task.due_date) {
    out.push(
      <TaskFact
        key="due"
        icon={<Clock />}
        tone={isOverdue(task.due_date) ? "alert" : undefined}
        title={`Due ${task.due_date}`}
      >
        {formatDueDate(task.due_date)}
      </TaskFact>,
    );
  }
  if (props.has("estimate") && task.estimate != null) {
    out.push(
      <TaskFact key="est" title="Estimate">
        {task.estimate} pts
      </TaskFact>,
    );
  }
  if (childCount > 0) {
    out.push(
      <TaskFact
        key="children"
        icon={<GitBranch />}
        title={`${childCount} sub-task${childCount === 1 ? "" : "s"}`}
      >
        {childCount}
      </TaskFact>,
    );
  }
  if (task.crew_id) {
    out.push(
      <TaskFact key="crew" icon={<Users />} title={`Crew: ${task.crew_id}`}>
        {task.crew_id}
      </TaskFact>,
    );
  }
  const plan = stepProgress(task);
  if (plan) {
    out.push(
      <TaskFact
        key="plan"
        icon={<ListChecks />}
        title={`Plan: ${plan.done} of ${plan.total} steps done`}
      >
        {plan.done} of {plan.total}
      </TaskFact>,
    );
  }
  if (props.has("labels") && task.labels.length > 0) {
    const names = task.labels.map(
      (l) => taskLabels.find((cl) => cl.name === l || cl.id === l)?.name ?? l,
    );
    out.push(
      <TaskFact key="labels" icon={<Tag />} title={names.join(", ")}>
        {names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`}
      </TaskFact>,
    );
  }
  return out;
}

/** "Move to …", open, open in a new tab, copy the handle. */
export function TaskMenuItems({
  task,
  onStatus,
  onOpen,
}: {
  task: Task;
  onStatus?: (next: TaskStatus) => void;
  onOpen: (e: TaskOpenModifiers) => void;
}) {
  const handle = `AURA-${task.sequence_id}`;
  return (
    <>
      {onStatus &&
        TASK_STATUS_ORDER.map((id) => (
          <ContextMenuItem key={id} disabled={id === task.status} onSelect={() => onStatus(id)}>
            Move to {TASK_STATUS_LABEL[id]}
          </ContextMenuItem>
        ))}
      {onStatus && <ContextMenuSeparator />}
      <ContextMenuItem onSelect={() => onOpen({ shiftKey: false })}>Open task</ContextMenuItem>
      <ContextMenuItem onSelect={() => onOpen({ shiftKey: true })}>Open in new tab</ContextMenuItem>
      {task.sequence_id > 0 && (
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(handle)}>
          Copy {handle}
        </ContextMenuItem>
      )}
    </>
  );
}
