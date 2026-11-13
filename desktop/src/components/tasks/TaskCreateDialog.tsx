// New task: a title, an optional description, a status and the owners —
// what it takes to file one. Priority, agent, sprint, epic, dates, estimate,
// labels and objective are set on the task once it exists, in its detail or
// its Edit task dialog. A template's preset for any of those still rides
// along, shown as chips that can be taken off.
//
// Enter in the title or ⌘/Ctrl-Enter anywhere creates; Escape closes.

import { useMemo, useRef, useState } from "react";
import { ChevronDown, CornerDownLeft, UserRound } from "lucide-react";

import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TasksCreateDialog } from "../ui/tasks-create";
import { TaskOwnerPicker } from "../ui/tasks-form";
import { WorkspaceStageIcon } from "../ui/workspace-preview-card";
import type { CreateTaskInput, TaskStatus, TeamMember } from "../../lib/api";
import { TASK_STATUS_OPTIONS, taskStatusLabel } from "../../lib/taskStatus";
import { stageForStatus } from "./taskGlyphs";
import { taskCreateChips } from "./taskCreateChips";
import { draftFrom, draftToCreate, type TaskDraft } from "./taskDraft";

export function TaskCreateDialog({
  members,
  onCancel,
  onSubmit,
  defaultAssignee,
  initial,
}: {
  members: TeamMember[];
  onCancel: () => void;
  /** Files the task. A throw keeps the dialog open with the reason. */
  onSubmit: (input: CreateTaskInput) => Promise<void>;
  /** The reader's handle: the default owner and the reporter. */
  defaultAssignee?: string;
  /** A template's preset, or the column a "+" was pressed in. */
  initial?: Partial<CreateTaskInput>;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() =>
    draftFrom(null, initial, defaultAssignee),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const owners = useMemo(
    () =>
      members
        .filter((m) => m.handle)
        .map((m) => ({ value: m.handle, name: m.name || m.handle })),
    [members],
  );
  const chips = taskCreateChips(draft).map((c) => ({
    key: c.key,
    label: c.label,
    onRemove: () => setDraft((d) => ({ ...d, ...c.clear })),
  }));
  const canCreate = draft.title.trim().length > 0 && !saving;

  async function create() {
    if (!canCreate) {
      titleRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draftToCreate(draft, defaultAssignee));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const statusName = taskStatusLabel(draft.status);
  const footer = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Status: ${statusName}. Change it`}>
            <WorkspaceStageIcon stage={stageForStatus(draft.status)} />
            <span>{statusName}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={draft.status}
            onValueChange={(v) => set("status", v as TaskStatus)}
          >
            {TASK_STATUS_OPTIONS.map((s) => (
              <DropdownMenuRadioItem key={s.id} value={s.id}>
                <WorkspaceStageIcon stage={stageForStatus(s.id)} />
                {s.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <TaskOwnerPicker
        inline
        size="sm"
        icon={<UserRound />}
        values={draft.assigneeIds}
        options={owners}
        onChange={(next) => set("assigneeIds", next)}
      />
      <span className="ui-workspaces-create-spacer" />
      <Button type="submit" size="sm" disabled={!canCreate}>
        {saving ? (
          <>
            <AsciiSpinner />
            Creating…
          </>
        ) : (
          <>
            Create
            <CornerDownLeft size={13} />
          </>
        )}
      </Button>
    </>
  );

  return (
    <TasksCreateDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={draft.title}
      onTitleChange={(next) => set("title", next)}
      description={draft.description}
      onDescriptionChange={(next) => set("description", next)}
      footer={footer}
      chips={chips}
      notes={error ? [{ key: "error", tone: "danger", children: error }] : []}
      onSubmit={() => void create()}
      busy={saving}
      titleRef={titleRef}
    />
  );
}
