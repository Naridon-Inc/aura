import { useEffect, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select } from "./select";
import { AsciiSpinner } from "./ascii-spinner";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";
import { TaskList, type TaskItem } from "./tasks";
export interface DetailedTask extends TaskItem {
  blockedBy?: string[];
  blocks?: string[];
}
export function TaskDetails({
  task,
  tasks,
  loading,
  onOpenTask,
  onEdit,
}: {
  task?: DetailedTask;
  tasks: DetailedTask[];
  loading?: boolean;
  onOpenTask: (id: string) => void;
  onEdit?: () => void;
}) {
  if (loading)
    return (
      <div className="ui-pattern-empty" role="status">
        <AsciiSpinner />
        Loading task…
      </div>
    );
  if (!task) return <div className="ui-pattern-empty">Select a task to view its details.</div>;
  return (
    <section className="ui-task-details">
      <header>
        <strong>{task.subject}</strong>
        {onEdit && (
          <Button size="xs" variant="ghost" onClick={onEdit}>
            Edit task
          </Button>
        )}
      </header>
      <small>
        {task.status.replace(/_/g, " ")}
        {task.owner && ` · ${task.owner}`}
      </small>
      {task.description && <p>{task.description}</p>}
      {(["blockedBy", "blocks"] as const).map((relation) =>
        task[relation]?.length ? (
          <div key={relation}>
            <h4>{relation === "blockedBy" ? "Blocked by" : "Blocks"}</h4>
            {task[relation]!.map((id) => (
              <button className="ui-task-dependency" key={id} onClick={() => onOpenTask(id)}>
                <span>{tasks.find((item) => item.id === id)?.subject ?? `Task ${id}`}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        ) : null,
      )}
    </section>
  );
}
export function TaskEditor({
  task,
  open,
  onOpenChange,
  onSave,
}: {
  task?: DetailedTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: Omit<DetailedTask, "id">) => void;
}) {
  const [subject, setSubject] = useState(""),
    [description, setDescription] = useState(""),
    [owner, setOwner] = useState(""),
    [status, setStatus] = useState<TaskItem["status"]>("pending");
  useEffect(() => {
    if (open) {
      setSubject(task?.subject ?? "");
      setDescription(task?.description ?? "");
      setOwner(task?.owner ?? "");
      setStatus(task?.status ?? "pending");
    }
  }, [open, task]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{task ? "Edit task" : "Create task"}</DialogTitle>
        <DialogDescription>Track the work, owner, and current status.</DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (subject.trim()) {
              onSave({ ...task, subject: subject.trim(), description, owner, status });
              onOpenChange(false);
            }
          }}
        >
          <label className="ui-form-field">
            Title
            <Input
              autoFocus
              required
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          <label className="ui-form-field">
            Description
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="ui-form-field">
            Owner
            <Input value={owner} onChange={(event) => setOwner(event.target.value)} />
          </label>
          <label className="ui-form-field">
            Status
            <Select
              value={status}
              onChange={(value) => setStatus(value as TaskItem["status"])}
              options={[
                { value: "pending", label: "Pending" },
                { value: "in_progress", label: "In progress" },
                { value: "completed", label: "Completed" },
              ]}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!subject.trim()}>
              Save task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function TaskManager({
  tasks,
  onChange,
}: {
  tasks: DetailedTask[];
  onChange: (tasks: DetailedTask[]) => void;
}) {
  const [selected, setSelected] = useState<string>(),
    [editing, setEditing] = useState(false),
    [creating, setCreating] = useState(false);
  const current = tasks.find((task) => task.id === selected);
  return (
    <section className="ui-task-manager">
      <header>
        <strong>Tasks</strong>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setCreating(true);
            setEditing(true);
          }}
        >
          <Plus />
          New task
        </Button>
      </header>
      <TaskList
        tasks={tasks}
        onStatusChange={(id, status) =>
          onChange(tasks.map((task) => (task.id === id ? { ...task, status } : task)))
        }
      />
      <div className="ui-task-links">
        {tasks.map((task) => (
          <button
            key={task.id}
            aria-current={selected === task.id ? "true" : undefined}
            onClick={() => setSelected(task.id)}
          >
            {task.subject}
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
      <TaskDetails
        task={current}
        tasks={tasks}
        onOpenTask={setSelected}
        onEdit={
          current
            ? () => {
                setCreating(false);
                setEditing(true);
              }
            : undefined
        }
      />
      <TaskEditor
        task={creating ? undefined : current}
        open={editing}
        onOpenChange={setEditing}
        onSave={(value) => {
          if (creating) {
            const id = crypto.randomUUID();
            onChange([...tasks, { ...value, id }]);
            setSelected(id);
          } else
            onChange(tasks.map((task) => (task.id === selected ? { ...task, ...value } : task)));
        }}
      />
    </section>
  );
}
export function RunningTasksDialog({
  open,
  onOpenChange,
  tasks,
  onKeepRunning,
  onStopAndClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: string[];
  onKeepRunning: () => void;
  onStopAndClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Tasks are still running</AlertDialogTitle>
        <AlertDialogDescription>
          Choose whether background work should continue after closing this view.
        </AlertDialogDescription>
        <ul className="ui-running-task-list">
          {tasks.map((task, index) => (
            <li key={`${task}-${index}`}>
              <AsciiSpinner />
              {task}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            onClick={() => {
              onKeepRunning();
              onOpenChange(false);
            }}
          >
            Keep running
          </Button>
          <AlertDialogAction onClick={onStopAndClose}>Stop and close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
