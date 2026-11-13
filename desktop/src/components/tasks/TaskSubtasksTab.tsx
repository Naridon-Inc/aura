// The Sub-tasks tab of a task's detail: the parent's direct children listed
// on the left, the one you pick read on the right with the same column and
// properties the parent uses, so a sub-task reads like any other task.

import { useMemo, useState } from "react";
import { ArrowUpRight, Plus } from "lucide-react";

import type { Cycle, Module, Task, TaskState, TeamMember, UpdateTaskInput } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { relativeAgeFromIso } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  TaskDetailHeader,
  TaskDetailLayout,
  TaskDetailMeta,
} from "../ui/tasks-detail";
import { TaskFormError } from "../ui/tasks-form";
import { TaskHandle, TaskListItem } from "../ui/tasks-list";
import { TaskPlan } from "./TaskPlan";
import { TaskObjective, TaskRunOrder, TaskTitleField } from "./TaskDetailBlocks";
import { TaskDetailProperties } from "./TaskDetailProperties";
import { DescriptionCard } from "./TaskDescriptionCard";
import { TASK_PRIORITY_LABEL, TaskPriorityBars, TaskStateChip, TaskStatusTag } from "./taskGlyphs";

export function TaskSubtasksTab({
  parent,
  childTasks,
  allTasks,
  repoRoot,
  members,
  taskStates,
  cycles,
  modules,
  onPatch,
  onCreateChild,
  onStepSet,
  onOpenTask,
  selectedId: selProp,
  onSelect,
}: {
  parent: Task;
  childTasks: Task[];
  allTasks: Task[];
  repoRoot: string;
  members: TeamMember[];
  taskStates: TaskState[];
  cycles: Cycle[];
  modules: Module[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  onCreateChild: (parentId: string, title: string) => Promise<void>;
  /** Tick a step off — on the child being read, not on the parent. */
  onStepSet: (id: string, index: number, done: boolean) => Promise<void>;
  /** Open a task that isn't one of these children in the detail. */
  onOpenTask: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const editor = useEditorStore();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // A stored selection that has gone (deleted, moved) falls back to the
  // first child.
  const selectedId =
    selProp && childTasks.some((c) => c.id === selProp) ? selProp : childTasks[0]?.id ?? null;
  const selected = useMemo(
    () => childTasks.find((c) => c.id === selectedId) ?? null,
    [childTasks, selectedId],
  );
  const stateOf = (t: Task) =>
    t.state_id ? taskStates.find((s) => s.id === t.state_id) ?? null : null;

  const submit = async () => {
    const t = draft.trim();
    if (!t || creating) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await onCreateChild(parent.id, t);
      setDraft("");
      setAdding(false);
    } catch {
      // Keep the draft and the input so a retry needs no retyping.
      setCreateErr("Couldn't add the sub-task. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  const openFromRunOrder = (id: string) => {
    if (childTasks.some((c) => c.id === id)) onSelect(id);
    else onOpenTask(id);
  };

  return (
    <div className="ui-tasks-subtasks">
      <aside className="ui-tasks-subtasks-list" aria-label="Sub-tasks">
        <div className="ui-tasks-subtasks-head">
          <span>Sub-tasks</span>
          <span className="ui-tasks-detail-count">{childTasks.length}</span>
          <Button
            variant="ghost"
            size="iconXs"
            onClick={() => setAdding(true)}
            title="Add a sub-task"
            aria-label="Add a sub-task"
          >
            <Plus aria-hidden />
          </Button>
        </div>
        <div role="list" className="ui-tasks-subtasks-rows">
          {childTasks.map((c) => (
            <TaskListItem
              key={c.id}
              taskId={c.id}
              label={c.title || "(untitled)"}
              selected={c.id === selectedId}
              leading={
                <>
                  <TaskStatusTag state={stateOf(c)} status={c.status} />
                  {c.sequence_id > 0 && <TaskHandle>AURA-{c.sequence_id}</TaskHandle>}
                </>
              }
              title={c.title || "(untitled)"}
              trailing={<TaskPriorityBars priority={c.priority} />}
              onOpen={() => onSelect(c.id)}
            />
          ))}
        </div>
        {adding && (
          <div className="ui-tasks-subtasks-add">
            <Input
              value={draft}
              autoFocus
              size="small"
              aria-label="Sub-task title"
              placeholder="Sub-task title. Enter to add"
              disabled={creating}
              onChange={(e) => {
                setDraft(e.target.value);
                if (createErr) setCreateErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAdding(false);
                  setDraft("");
                  setCreateErr(null);
                }
              }}
              onBlur={() => {
                if (!draft.trim() && !creating) setAdding(false);
              }}
            />
            {createErr && <TaskFormError>{createErr}</TaskFormError>}
          </div>
        )}
      </aside>

      {selected ? (
        <TaskDetailLayout
          asideLabel="Sub-task properties"
          main={
            <>
              <TaskDetailHeader
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => editor.openTaskDetail(selected.id, repoRoot)}
                    title="Open this sub-task as its own page"
                  >
                    <ArrowUpRight aria-hidden />
                    Open
                  </Button>
                }
              >
                <TaskTitleField key={`t-${selected.id}`} task={selected} onPatch={onPatch} />
              </TaskDetailHeader>
              <TaskDetailMeta
                parts={[
                  selected.sequence_id > 0 && `AURA-${selected.sequence_id}`,
                  <TaskStateChip state={stateOf(selected)} status={selected.status} />,
                  TASK_PRIORITY_LABEL[selected.priority],
                  `Updated ${relativeAgeFromIso(selected.updated_at)}`,
                ]}
              />
              <TaskObjective task={selected} />
              <DescriptionCard
                key={`d-${selected.id}`}
                task={selected}
                members={members}
                onPatch={onPatch}
              />
              <TaskPlan
                key={`p-${selected.id}`}
                task={selected}
                onStepSet={(index, done) => onStepSet(selected.id, index, done)}
              />
              <TaskRunOrder task={selected} allTasks={allTasks} onOpen={openFromRunOrder} />
            </>
          }
          aside={
            <TaskDetailProperties
              task={selected}
              allTasks={allTasks}
              repoRoot={repoRoot}
              members={members}
              taskStates={taskStates}
              cycles={cycles}
              modules={modules}
              onPatch={onPatch}
              onOpenTask={openFromRunOrder}
            />
          }
        />
      ) : (
        <div className="ui-tasks-detail-empty">Select a sub-task to view its details.</div>
      )}
    </div>
  );
}
