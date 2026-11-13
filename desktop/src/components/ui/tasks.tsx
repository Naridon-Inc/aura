import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot } from "lucide-react";
export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
}
export function TaskList({
  tasks,
  onStatusChange,
  onOpen,
}: {
  tasks: TaskItem[];
  onStatusChange?: (id: string, status: TaskItem["status"]) => void;
  /** Aura: a row whose text opens the task. Without it the text is plain. */
  onOpen?: (id: string) => void;
}) {
  if (!tasks.length) return <p className="ui-task-empty">No tasks</p>;
  return (
    <div className="ui-task-list">
      {tasks.map((task) => (
        <div key={task.id} className="ui-task" data-status={task.status}>
          <button
            type="button"
            disabled={!onStatusChange}
            aria-label={`${task.subject}: ${task.status.replace("_", " ")}`}
            onClick={() =>
              onStatusChange?.(task.id, task.status === "completed" ? "pending" : "completed")
            }
          >
            {task.status === "completed" ? (
              <CircleCheck size={16} />
            ) : task.status === "in_progress" ? (
              <CircleDot size={16} />
            ) : (
              <Circle size={16} />
            )}
          </button>
          {onOpen ? (
            <button type="button" className="ui-task-open" onClick={() => onOpen(task.id)}>
              <TaskText task={task} />
            </button>
          ) : (
            <div>
              <TaskText task={task} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function TaskText({ task }: { task: TaskItem }) {
  return (
    <>
      <p>{task.subject}</p>
      {task.description && <small>{task.description}</small>}
      {task.owner && <small>Owner: {task.owner}</small>}
    </>
  );
}
export function TaskPanel({
  tasks,
  onStatusChange,
  onOpen,
}: {
  tasks: TaskItem[];
  onStatusChange?: (id: string, status: TaskItem["status"]) => void;
  onOpen?: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="ui-task-panel">
      <button
        type="button"
        className="ui-task-panel-trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Tasks
        <span>
          {tasks.filter((t) => t.status === "completed").length}/{tasks.length}
        </span>
      </button>
      {open && <TaskList tasks={tasks} onStatusChange={onStatusChange} onOpen={onOpen} />}
    </section>
  );
}
