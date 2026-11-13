// Edit a task: every field it has. Title, description, owner and status come
// first; the planning fields Aura tracks follow under their own heading.
// Creating one is the short dialog in TaskCreateDialog — this is where the
// rest gets filled in once the task exists.
//
// ⌘/Ctrl-Enter saves from anywhere in the form, including the description.

import { useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, type SelectOption } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { TaskFormError, TaskOwnerPicker } from "../ui/tasks-form";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import { TASK_STATUS_OPTIONS } from "../../lib/taskStatus";
import { stageForStatus } from "./taskGlyphs";
import { TaskPlanningFields } from "./TaskPlanningFields";
import { draftFrom, draftToUpdate, type TaskDraft } from "./taskDraft";
import type {
  Sprint,
  Task,
  TaskStatus,
  TeamMember,
  UpdateTaskInput,
} from "../../lib/api";

const STATUS_OPTS: SelectOption[] = TASK_STATUS_OPTIONS.map((s) => ({
  value: s.id,
  label: s.label,
  icon: <WorkspaceStageIcon stage={stageForStatus(s.id)} />,
}));

type Props = {
  /** The task being edited. */
  editing: Task;
  members: TeamMember[];
  /** Every task on the board — the parent-epic list reads it. */
  tasks: Task[];
  sprints: Sprint[];
  onCancel: () => void;
  onSubmit: (input: UpdateTaskInput) => Promise<void>;
};

export function TaskEditorDialog({ editing, members, tasks, sprints, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = useState<TaskDraft>(() => draftFrom(editing, undefined, undefined));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const owners = members
    .filter((m) => m.handle)
    .map((m) => ({ value: m.handle, name: m.name || m.handle }));
  const canSave = draft.title.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draftToUpdate(draft, editing.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function onSubmitForm(e: FormEvent) {
    e.preventDefault();
    void save();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogTitle>Edit task</DialogTitle>
        <DialogDescription>Track the work, owner, and current status.</DialogDescription>
        <form onSubmit={onSubmitForm} onKeyDown={onKeyDown}>
          <label className="ui-form-field">
            Title
            <Input
              autoFocus
              required
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </label>
          <label className="ui-form-field">
            Description
            <Textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </label>
          <label className="ui-form-field">
            Owner
            <TaskOwnerPicker
              values={draft.assigneeIds}
              options={owners}
              onChange={(next) => set("assigneeIds", next)}
            />
          </label>
          <label className="ui-form-field">
            Status
            <Select
              value={draft.status}
              onChange={(v) => set("status", v as TaskStatus)}
              options={STATUS_OPTS}
            />
          </label>
          <TaskPlanningFields
            draft={draft}
            set={set}
            tasks={tasks}
            sprints={sprints}
            editingId={editing.id}
          />
          {error && <TaskFormError>{error}</TaskFormError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? "Saving…" : "Save task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
