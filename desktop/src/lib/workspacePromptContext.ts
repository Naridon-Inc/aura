// Parity W8 — prompt-context enrichment from the task board.
//
// When a workspace launch (or a PR skill) seeds an agent with a prompt, the
// agent shouldn't have to re-discover what it's working on — the task board
// already knows. This module renders relevant `.aura/tasks/` entries into a
// compact markdown block the caller appends to the seed prompt.
//
// Selection: explicit `taskIds` win (matched by raw id or `AURA-<n>` handle);
// otherwise in-flight work first (`in_progress`, then `backlog`). Hard caps on
// task count and total characters keep the block from eating the agent's
// context window — this is grounding, not a data dump.

import { type Task } from "./api";
import { fetchTasks } from "./tasksCache";

export type WorkspacePromptContextOptions = {
  /** Explicit tasks to include, by id or `AURA-<n>` handle (case-insensitive). */
  taskIds?: string[];
  /** Max tasks rendered. */
  maxTasks?: number;
  /** Max total characters of the rendered block. */
  maxChars?: number;
};

const DEFAULT_MAX_TASKS = 5;
const DEFAULT_MAX_CHARS = 6000;
/** Per-task description budget so one essay-length task can't crowd out the rest. */
const MAX_DESCRIPTION_CHARS = 1200;

/** Render one task as a markdown bullet block. Pure — testable without IO. */
export function formatTaskContext(task: Task): string {
  const handle = task.sequence_id > 0 ? `AURA-${task.sequence_id}` : task.id;
  const lines = [`### ${handle}: ${task.title}`];
  const meta: string[] = [`status: ${task.status}`];
  if (task.priority && task.priority !== "none") meta.push(`priority: ${task.priority}`);
  if (task.agent_assignee) meta.push(`agent: ${task.agent_assignee}`);
  lines.push(`- ${meta.join(" · ")}`);
  const desc = task.description.trim();
  if (desc) {
    lines.push(
      desc.length > MAX_DESCRIPTION_CHARS ? `${desc.slice(0, MAX_DESCRIPTION_CHARS)}…` : desc,
    );
  }
  return lines.join("\n");
}

function matchesId(task: Task, wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return false;
  if (task.id.toLowerCase() === w) return true;
  return task.sequence_id > 0 && `aura-${task.sequence_id}` === w;
}

/**
 * Build the task-board context block for a workspace. Returns `""` when there
 * is nothing relevant — callers append it raw, so empty must mean "no block".
 * Board read failures degrade to `""` too: context is enrichment, never a gate.
 */
export async function buildWorkspacePromptContext(
  repoRoot: string,
  options: WorkspacePromptContextOptions = {},
): Promise<string> {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  let tasks: Task[];
  try {
    tasks = await fetchTasks(repoRoot);
  } catch {
    return "";
  }
  if (!Array.isArray(tasks) || tasks.length === 0) return "";

  let picked: Task[];
  if (options.taskIds && options.taskIds.length > 0) {
    picked = options.taskIds
      .map((wanted) => tasks.find((t) => matchesId(t, wanted)))
      .filter((t): t is Task => t != null);
  } else {
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const backlog = tasks.filter((t) => t.status === "backlog");
    picked = [...inProgress, ...backlog];
  }
  picked = picked.slice(0, maxTasks);
  if (picked.length === 0) return "";

  const blocks: string[] = ["## Task board"];
  let used = blocks[0].length;
  for (const task of picked) {
    const block = formatTaskContext(task);
    if (used + block.length + 2 > maxChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  // Only the header survived the budget → nothing useful to say.
  if (blocks.length === 1) return "";
  return blocks.join("\n\n");
}
