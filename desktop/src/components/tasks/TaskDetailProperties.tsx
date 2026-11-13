// A task's properties column: status, people, labels, sprint and
// workstream, and relations — each one edits the task in place.

import type { Cycle, Module, Task, TaskState, TeamMember, UpdateTaskInput } from "../../lib/api";
import { AssignmentCard, LabelsCard, PlanningCard, StatusCard } from "./TaskPropertyCards";
import { RelationsCard } from "./TaskRelationsCard";

export function TaskDetailProperties({
  task,
  allTasks,
  repoRoot,
  members,
  taskStates,
  cycles,
  modules,
  onPatch,
  onOpenTask,
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  members: TeamMember[];
  taskStates: TaskState[];
  cycles: Cycle[];
  modules: Module[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  /** Opens a related task in the same pane. */
  onOpenTask: (id: string) => void;
}) {
  return (
    <>
      <StatusCard task={task} taskStates={taskStates} onPatch={onPatch} />
      <AssignmentCard task={task} members={members} onPatch={onPatch} />
      <LabelsCard task={task} allTasks={allTasks} onPatch={onPatch} />
      {(cycles.length > 0 || modules.length > 0) && (
        <PlanningCard
          task={task}
          cycles={cycles}
          modules={modules}
          onPatch={onPatch}
        />
      )}
      <RelationsCard
        task={task}
        allTasks={allTasks}
        repoRoot={repoRoot}
        onOpenTask={onOpenTask}
      />
    </>
  );
}
