// What a new task carries that the new-task dialog has no field for.
//
// The dialog asks for a title, a description, a status and the owners. A
// template can also preset a priority, labels, an estimate, an agent, dates or
// the epic flag. Those ride along as chips under the description, so nothing
// is filed that the reader didn't see, and taking a chip off puts that one
// field back to what a blank task starts with.

import { TASK_PRIORITY_LABEL } from "./taskColumns";
import { parseLabels, TASK_AGENTS, type TaskDraft } from "./taskDraft";

export interface TaskCreateChip {
  key: string;
  label: string;
  /** The fields to write back when the chip is taken off. */
  clear: Partial<TaskDraft>;
}

/** The priority a blank task starts with; only another one earns a chip. */
const DEFAULT_PRIORITY = "medium";

export function taskCreateChips(d: TaskDraft): TaskCreateChip[] {
  const chips: TaskCreateChip[] = [];
  if (d.priority !== DEFAULT_PRIORITY) {
    chips.push({
      key: "priority",
      label:
        d.priority === "none"
          ? "No priority"
          : `${TASK_PRIORITY_LABEL[d.priority] ?? d.priority} priority`,
      clear: { priority: DEFAULT_PRIORITY },
    });
  }
  if (d.isEpic) chips.push({ key: "epic", label: "Epic", clear: { isEpic: false } });
  const agent = d.agent.trim();
  if (agent) {
    const name = TASK_AGENTS.find((a) => a.value === agent)?.label ?? agent;
    chips.push({ key: "agent", label: `Agent: ${name}`, clear: { agent: "" } });
  }
  const labels = parseLabels(d.labels);
  for (const label of labels) {
    chips.push({
      key: `label:${label}`,
      label,
      clear: { labels: labels.filter((l) => l !== label).join(", ") },
    });
  }
  if (d.estimate.trim()) {
    chips.push({ key: "estimate", label: `${d.estimate.trim()} pts`, clear: { estimate: "" } });
  }
  if (d.startDate.trim()) {
    chips.push({ key: "start", label: `Starts ${d.startDate.trim()}`, clear: { startDate: "" } });
  }
  if (d.dueDate.trim()) {
    chips.push({ key: "due", label: `Due ${d.dueDate.trim()}`, clear: { dueDate: "" } });
  }
  if (d.cycleId.trim()) chips.push({ key: "sprint", label: "In a sprint", clear: { cycleId: "" } });
  if (d.epicId.trim()) chips.push({ key: "parent", label: "In an epic", clear: { epicId: "" } });
  if (d.objective.trim()) {
    chips.push({
      key: "objective",
      label: `Objective: ${d.objective.trim()}`,
      clear: { objective: "" },
    });
  }
  return chips;
}
