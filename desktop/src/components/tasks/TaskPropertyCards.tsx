// A task's property sections — Status, Assignment, Labels and Planning —
// each a run of label/value rows whose value is the control that changes it.
//
// No section owns task state: each reads the live `Task` off props and
// pushes every edit through `onPatch` (the parent's `tasksUpdate` wrapper),
// so the detail pane stays the single source of truth.

import { useMemo } from "react";
import { Bot, X } from "lucide-react";

import type {
  Cycle,
  Module,
  Task,
  TaskPriority,
  TaskState,
  TaskStatus,
  TeamMember,
  UpdateTaskInput,
} from "../../lib/api";
import { TASK_STATUS_OPTIONS } from "../../lib/taskStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { TaskDetailSection } from "../ui/tasks-detail";
import { TaskOwnerPicker } from "../ui/tasks-form";
import { TaskProperty, TaskPropertyEmpty, TaskPropertyList } from "../ui/tasks-properties";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import { TaskLabelPicker } from "./TaskLabelPicker";
import { TaskDateField, TaskPropertyMenu } from "./TaskPropertyMenus";
import { TaskStatePicker } from "./TaskStatePicker";
import { stageForStatus, TASK_PRIORITY_LABEL, TaskPriorityBars } from "./taskGlyphs";

type Patch = (input: UpdateTaskInput) => Promise<void>;

// Most urgent first, so the arrow keys walk down in importance.
const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];
const PRIORITY_OPTIONS = PRIORITY_ORDER.map((p) => ({
  value: p,
  label: TASK_PRIORITY_LABEL[p],
  icon: <TaskPriorityBars priority={p} />,
}));
const STATUS_OPTIONS = TASK_STATUS_OPTIONS.map((s) => ({
  value: s.id,
  label: s.label,
  icon: <WorkspaceStageIcon stage={stageForStatus(s.id)} />,
}));

export function StatusCard({
  task,
  taskStates,
  onPatch,
}: {
  task: Task;
  taskStates: TaskState[];
  onPatch: Patch;
}) {
  // The state catalog is preferred when it has loaded. The plain status menu
  // stays as the fallback, so a slow catalog (or a repository missing
  // task_states.json) never leaves the reader without a way to change state.
  // The backend mirrors state_id onto status on every write, so the two
  // stay in step.
  return (
    <TaskDetailSection title="Status">
      <TaskPropertyList>
        <TaskProperty label="State">
          {taskStates.length > 0 ? (
            <TaskStatePicker
              states={taskStates}
              value={task.state_id ?? null}
              status={task.status}
              onChange={(stateId) => onPatch({ id: task.id, state_id: stateId })}
            />
          ) : (
            <TaskPropertyMenu
              label="Status"
              value={task.status}
              options={STATUS_OPTIONS}
              onChange={(v) => onPatch({ id: task.id, status: v as TaskStatus })}
            />
          )}
        </TaskProperty>
        <TaskProperty label="Priority">
          <TaskPropertyMenu
            label="Priority"
            value={task.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => onPatch({ id: task.id, priority: v as TaskPriority })}
          />
        </TaskProperty>
        <TaskProperty label="Start">
          <TaskDateField
            label="Start date"
            value={task.start_date ?? ""}
            onChange={(v) => onPatch({ id: task.id, start_date: v })}
          />
        </TaskProperty>
        <TaskProperty label="Due">
          <TaskDateField
            label="Due date"
            value={task.due_date ?? ""}
            onChange={(v) => onPatch({ id: task.id, due_date: v })}
          />
        </TaskProperty>
      </TaskPropertyList>
    </TaskDetailSection>
  );
}

export function AssignmentCard({
  task,
  members,
  onPatch,
}: {
  task: Task;
  members: TeamMember[];
  onPatch: Patch;
}) {
  const people = useMemo(
    () =>
      members
        .filter((m) => m.handle)
        .map((m) => ({ value: m.handle, name: m.name || m.handle })),
    [members],
  );
  return (
    <TaskDetailSection title="Assignment">
      <TaskPropertyList>
        <TaskProperty label="Humans">
          {/* Sends `assignee_ids`; the backend mirrors the first onto the
              single `assignee` so older readers keep working. */}
          <TaskOwnerPicker
            inline
            values={task.assignee_ids}
            options={people}
            onChange={(handles) => onPatch({ id: task.id, assignee_ids: handles })}
          />
        </TaskProperty>
        <TaskProperty label="Agent">
          {task.agent_assignee ? (
            <>
              <Badge variant="highlight" title={`Agent: ${task.agent_assignee}`}>
                <Bot size={12} aria-hidden />
                {task.agent_assignee}
              </Badge>
              <Button
                variant="ghost"
                size="iconXs"
                aria-label="Take the agent off this task"
                title="Take the agent off this task"
                onClick={() => onPatch({ id: task.id, agent_assignee: "" })}
              >
                <X aria-hidden />
              </Button>
            </>
          ) : (
            <TaskPropertyEmpty>None</TaskPropertyEmpty>
          )}
        </TaskProperty>
        {task.reporter && (
          <TaskProperty label="Reporter">
            <span>@{task.reporter}</span>
          </TaskProperty>
        )}
      </TaskPropertyList>
    </TaskDetailSection>
  );
}

export function LabelsCard({
  task,
  allTasks,
  onPatch,
}: {
  task: Task;
  allTasks: Task[];
  onPatch: Patch;
}) {
  const known = useMemo(() => [...new Set(allTasks.flatMap((t) => t.labels))], [allTasks]);
  return (
    <TaskDetailSection title="Labels" count={task.labels.length}>
      <TaskLabelPicker
        labels={task.labels}
        known={known}
        onChange={(labels) => onPatch({ id: task.id, labels })}
      />
    </TaskDetailSection>
  );
}

/** Sprint and workstream. Choosing "No sprint" / "No workstream" clears the
 *  pointer; the backend reads "" as null, so one shape covers set and clear. */
export function PlanningCard({
  task,
  cycles,
  modules,
  onPatch,
}: {
  task: Task;
  cycles: Cycle[];
  modules: Module[];
  onPatch: Patch;
}) {
  return (
    <TaskDetailSection title="Planning">
      <TaskPropertyList>
        {cycles.length > 0 && (
          <TaskProperty label="Sprint">
            <TaskPropertyMenu
              label="Sprint"
              value={task.cycle_id ?? ""}
              noneLabel="No sprint"
              options={cycles.map((c) => ({
                value: c.id,
                label: `${c.name}${c.status === "active" ? " · active" : ""}`,
              }))}
              onChange={(v) => onPatch({ id: task.id, cycle_id: v })}
            />
          </TaskProperty>
        )}
        {modules.length > 0 && (
          <TaskProperty label="Workstream">
            <TaskPropertyMenu
              label="Workstream"
              value={task.module_id ?? ""}
              noneLabel="No workstream"
              options={modules.map((m) => ({
                value: m.id,
                label: `${m.name}${m.status === "in_progress" ? " · in progress" : ""}`,
              }))}
              onChange={(v) => onPatch({ id: task.id, module_id: v })}
            />
          </TaskProperty>
        )}
      </TaskPropertyList>
    </TaskDetailSection>
  );
}
