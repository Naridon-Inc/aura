// The task form's planning fields: priority, agent, sprint, parent epic,
// dates, estimate, labels and objective. Drawn with the same form field,
// select and input as the dialog's title/owner/status block above them.

import { useMemo } from "react";

import { AgentIcon } from "../ui/agent-icon";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, type SelectOption } from "../ui/select";
import { TaskFormHeading, TaskFormRow } from "../ui/tasks-form";
import { TASK_PRIORITY_LABEL, TaskPriorityBars } from "./taskGlyphs";
import { TASK_AGENTS, type TaskDraft } from "./taskDraft";
import type { Sprint, Task, TaskPriority } from "../../lib/api";

const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

const PRIORITY_OPTS: SelectOption[] = PRIORITY_ORDER.map((p) => ({
  value: p,
  label: TASK_PRIORITY_LABEL[p],
  icon: <TaskPriorityBars priority={p} />,
}));

const AGENT_OPTS: SelectOption[] = [
  { value: "", label: "No agent" },
  ...TASK_AGENTS.map((a) => ({
    value: a.value,
    label: a.label,
    icon: <AgentIcon provider={a.value} size={14} />,
  })),
];

export function TaskPlanningFields({
  draft,
  set,
  tasks,
  sprints,
  editingId,
}: {
  draft: TaskDraft;
  set: <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
  tasks: Task[];
  sprints: Sprint[];
  /** The task being edited, kept out of its own parent-epic list. */
  editingId?: string;
}) {
  const sprintOpts = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "No sprint" },
      ...sprints.map((s) => ({
        value: s.id,
        label: s.active ? `${s.name} · active` : s.name,
      })),
    ],
    [sprints],
  );
  const epicOpts = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "No parent epic" },
      ...tasks
        .filter((t) => t.is_epic && t.id !== editingId)
        .map((t) => ({ value: t.id, label: t.title || "(untitled)" })),
    ],
    [tasks, editingId],
  );

  return (
    <>
      <TaskFormHeading>Planning</TaskFormHeading>
      <TaskFormRow>
        <label className="ui-form-field">
          Priority
          <Select
            value={draft.priority}
            onChange={(v) => set("priority", v as TaskPriority)}
            options={PRIORITY_OPTS}
          />
        </label>
        <label className="ui-form-field" title="Hand the task to an agent that picks it up on its own">
          Agent
          <Select value={draft.agent} onChange={(v) => set("agent", v)} options={AGENT_OPTS} />
        </label>
      </TaskFormRow>
      <TaskFormRow>
        <label className="ui-form-field">
          Sprint
          <Select
            value={draft.cycleId}
            onChange={(v) => set("cycleId", v)}
            options={sprintOpts}
            placeholder="No sprint"
          />
        </label>
        <label className="ui-form-field">
          Parent epic
          <Select
            value={draft.epicId}
            onChange={(v) => set("epicId", v)}
            options={epicOpts}
            disabled={draft.isEpic}
            placeholder="No parent epic"
          />
        </label>
      </TaskFormRow>
      <TaskFormRow>
        <label className="ui-form-field">
          Start date
          <Input
            type="date"
            value={draft.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
        </label>
        <label className="ui-form-field">
          Due date
          <Input
            type="date"
            value={draft.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
          />
        </label>
      </TaskFormRow>
      <TaskFormRow>
        <label className="ui-form-field">
          Estimate
          <Input
            type="number"
            min={0}
            value={draft.estimate}
            onChange={(e) => set("estimate", e.target.value)}
            suffix="pts"
          />
        </label>
        <label className="ui-form-field">
          Labels
          <Input
            value={draft.labels}
            onChange={(e) => set("labels", e.target.value)}
            placeholder="Separate with commas"
          />
        </label>
      </TaskFormRow>
      <label className="ui-form-field">
        Objective
        <Input
          value={draft.objective}
          onChange={(e) => set("objective", e.target.value)}
          placeholder="The goal or key result this serves"
        />
      </label>
      <label className="ui-check-label">
        <Checkbox
          checked={draft.isEpic}
          onCheckedChange={(v) => {
            const on = v === true;
            set("isEpic", on);
            if (on) set("epicId", "");
          }}
        />
        This is an epic. Epics group tasks and have no parent.
      </label>
    </>
  );
}
