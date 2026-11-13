// The pieces of a task's reading column that are this app's own: the
// subject you can edit in place, the objective, and the run order drawn as
// "Blocked by" / "Blocks" rows that open the task they name.

import { useEffect, useMemo, useState, type JSX } from "react";

import type { Task, UpdateTaskInput } from "../../lib/api";
import {
  TaskDependencyLinks,
  TaskDetailNote,
  TaskDetailSection,
  type TaskDependencyItem,
} from "../ui/tasks-detail";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import { stageForStatus } from "./taskGlyphs";

/** The subject, editable in place. Enter saves, Escape puts it back. */
export function TaskTitleField({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState(task.title);
  useEffect(() => {
    setTitle(task.title);
  }, [task.id, task.title]);

  const commit = () => {
    const next = title.trim();
    if (next && next !== task.title) void onPatch({ id: task.id, title: next });
    else setTitle(task.title);
  };

  return (
    <textarea
      className="ui-tasks-detail-title"
      aria-label="Task title"
      value={title}
      rows={1}
      placeholder="Untitled task"
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setTitle(task.title);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * What is true when this task is done — the statement the work gets checked
 * against. It sits above the description because it is the shorter, sharper
 * statement of the same subject.
 */
export function TaskObjective({ task }: { task: Task }): JSX.Element | null {
  const text = task.objective?.trim();
  if (!text) return null;
  return (
    <TaskDetailSection title="Objective">
      <p className="ui-tasks-detail-objective">{text}</p>
    </TaskDetailSection>
  );
}

/** A task as a dependency row: its title, status glyph and AURA handle. */
export function taskDependencyItem(id: string, byId: Map<string, Task>): TaskDependencyItem {
  const t = byId.get(id);
  if (!t) return { id, label: id };
  return {
    id,
    label: t.title || "(untitled)",
    icon: <WorkspaceStageIcon stage={stageForStatus(t.status)} />,
    hint: t.sequence_id > 0 ? `AURA-${t.sequence_id}` : undefined,
  };
}

/** What has to finish before this task, and what is waiting on it. */
export function TaskRunOrder({
  task,
  allTasks,
  onOpen,
}: {
  task: Task;
  allTasks: Task[];
  onOpen: (id: string) => void;
}): JSX.Element {
  const byId = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const blockedBy = (task.dependencies ?? []).map((id) => taskDependencyItem(id, byId));
  const blocks = allTasks
    .filter((t) => (t.dependencies ?? []).includes(task.id))
    .map((t) => taskDependencyItem(t.id, byId));
  // Only a task this board knows can be opened; an id from elsewhere stays
  // listed so the reader still sees it.
  const open = (id: string) => {
    if (byId.has(id)) onOpen(id);
  };

  if (blockedBy.length === 0 && blocks.length === 0) {
    return (
      <TaskDetailSection title="Blocked by">
        <TaskDetailNote>
          Nothing has to finish before this one, and nothing is waiting on it. Aura fills this in
          when it plans a run.
        </TaskDetailNote>
      </TaskDetailSection>
    );
  }
  return (
    <>
      {blockedBy.length > 0 && (
        <TaskDetailSection title="Blocked by" count={blockedBy.length}>
          <TaskDependencyLinks items={blockedBy} onOpen={open} />
        </TaskDetailSection>
      )}
      {blocks.length > 0 && (
        <TaskDetailSection title="Blocks" count={blocks.length}>
          <TaskDependencyLinks items={blocks} onOpen={open} />
        </TaskDetailSection>
      )}
    </>
  );
}
