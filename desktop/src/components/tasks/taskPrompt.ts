// Serialize a Task into a kickoff prompt for an agent (Aura Manager chat or a
// CLI agent like Claude Code). The user picks "Start in agent" on a task and
// the chosen agent opens seeded with this — the AURA-{n} ref + title lead,
// then the description, the sub-task checklist, and the handful of metadata
// fields an agent needs to start (priority, status, assignees, due date,
// objective). Deliberately compact: a kickoff, not the whole spec.

import type { Task } from "../../lib/api";

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "",
};

/** The human-facing ref for a task — `AURA-{sequence_id}`, falling back to the
 *  raw id for rows written before sequence numbers shipped (sequence_id 0). */
export function taskRef(task: Task): string {
  return task.sequence_id > 0 ? `AURA-${task.sequence_id}` : task.id;
}

function isDoneStatus(status: string): boolean {
  const s = (status || "").toLowerCase();
  return s === "done" || s === "completed" || s === "closed" || s === "cancelled";
}

/** Build the seed prompt handed to an agent when the user starts a task in it. */
export function buildTaskAgentPrompt(task: Task, childTasks: Task[] = []): string {
  const lines: string[] = [];

  lines.push("Let's start working on this task.");
  lines.push("");
  lines.push(`## ${taskRef(task)}: ${task.title}`);

  const meta: string[] = [];
  const prio = PRIORITY_LABEL[task.priority];
  if (prio) meta.push(`Priority: ${prio}`);
  if (task.status) meta.push(`Status: ${task.status}`);
  if (task.assignee_ids?.length) meta.push(`Assignee: ${task.assignee_ids.join(", ")}`);
  if (task.due_date) meta.push(`Due: ${task.due_date}`);
  if (task.objective) meta.push(`Objective: ${task.objective}`);
  if (meta.length) lines.push(`_${meta.join(" · ")}_`);

  const desc = task.description?.trim();
  if (desc) {
    lines.push("");
    lines.push(desc);
  }

  // The plan the task was filed with, if any — so the agent follows the stated
  // steps and reports progress against them rather than inventing its own path.
  const steps = task.steps ?? [];
  if (steps.length) {
    lines.push("");
    lines.push("### Plan");
    for (const s of steps) {
      lines.push(`- [${s.done ? "x" : " "}] ${s.text}`);
    }
  }

  if (childTasks.length) {
    lines.push("");
    lines.push("### Sub-tasks");
    for (const c of childTasks) {
      const cref = c.sequence_id > 0 ? `AURA-${c.sequence_id} ` : "";
      lines.push(`- [${isDoneStatus(c.status) ? "x" : " "}] ${cref}${c.title}`);
    }
  }

  lines.push("");
  lines.push(
    "Review the relevant code, propose an approach, then start implementing. Ask me if anything is ambiguous.",
  );

  return lines.join("\n");
}
