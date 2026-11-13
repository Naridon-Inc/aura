// The task form's draft: what the create and edit dialog holds while the
// reader types, and how it turns into the two payloads the board sends.
//
// Kept apart from the dialog so the conversion rules are one readable list.
// Create leaves an unset field out; edit sends "" for a field the reader
// cleared, because the backend reads "" as "clear this" and an absent field
// as "leave it alone".

import type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from "../../lib/api";

/** The agents a task can be handed to, by the id the task stores. */
export const TASK_AGENTS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "gemini", label: "Gemini" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

export type TaskDraft = {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeIds: string[];
  agent: string;
  /** Comma-separated, as typed. */
  labels: string;
  startDate: string;
  dueDate: string;
  /** As typed; parsed on submit. */
  estimate: string;
  /** Sprint membership rides the cycle pointer. */
  cycleId: string;
  epicId: string;
  isEpic: boolean;
  objective: string;
};

/** Seed the draft from the task being edited, else from a template preset,
 *  else from the reader's own handle as the owner. */
export function draftFrom(
  editing: Task | null | undefined,
  initial: Partial<CreateTaskInput> | undefined,
  defaultAssignee: string | undefined,
): TaskDraft {
  const presetOwners =
    initial?.assignee_ids && initial.assignee_ids.length > 0
      ? initial.assignee_ids
      : defaultAssignee
        ? [defaultAssignee]
        : [];
  const estimate = editing ? editing.estimate : initial?.estimate;
  return {
    title: editing?.title ?? "",
    description: editing?.description ?? "",
    status: editing?.status ?? initial?.status ?? "backlog",
    priority: editing?.priority ?? initial?.priority ?? "medium",
    assigneeIds: editing ? editing.assignee_ids ?? [] : presetOwners,
    agent: editing?.agent_assignee ?? initial?.agent_assignee ?? "",
    labels: (editing?.labels ?? initial?.labels ?? []).join(", "),
    startDate: editing?.start_date ?? initial?.start_date ?? "",
    dueDate: editing?.due_date ?? initial?.due_date ?? "",
    estimate: estimate != null ? String(estimate) : "",
    cycleId: editing?.cycle_id ?? initial?.cycle_id ?? "",
    epicId: editing?.epic_id ?? editing?.parent_id ?? initial?.epic_id ?? "",
    isEpic: editing?.is_epic ?? initial?.is_epic ?? false,
    objective: editing?.objective ?? initial?.objective ?? "",
  };
}

export function parseLabels(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEstimate(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function draftToCreate(d: TaskDraft, reporter?: string): CreateTaskInput {
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    status: d.status,
    priority: d.priority,
    assignee_ids: d.assigneeIds,
    agent_assignee: d.agent.trim() || undefined,
    reporter: reporter || undefined,
    labels: parseLabels(d.labels),
    due_date: d.dueDate.trim() || undefined,
    start_date: d.startDate.trim() || undefined,
    estimate: parseEstimate(d.estimate),
    epic_id: d.epicId.trim() || undefined,
    objective: d.objective.trim() || undefined,
    cycle_id: d.cycleId.trim() || undefined,
    is_epic: d.isEpic,
  };
}

export function draftToUpdate(d: TaskDraft, id: string): UpdateTaskInput {
  return {
    id,
    title: d.title.trim(),
    description: d.description.trim(),
    status: d.status,
    priority: d.priority,
    assignee_ids: d.assigneeIds,
    agent_assignee: d.agent.trim(),
    labels: parseLabels(d.labels),
    due_date: d.dueDate.trim(),
    start_date: d.startDate.trim(),
    estimate: parseEstimate(d.estimate),
    // An epic can't sit under another epic.
    epic_id: d.isEpic ? "" : d.epicId.trim(),
    objective: d.objective.trim(),
    cycle_id: d.cycleId.trim(),
    is_epic: d.isEpic,
  };
}
