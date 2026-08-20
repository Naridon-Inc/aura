// Deriving what a task's plan says about its progress, in one place so the
// board card, the detail pane's checklist, and the crew graph's node story
// all read the plan the same way. Mirrors the backend's
// `Task::step_progress` (cmd_tasks.rs): a task with no plan has *no* progress
// to report — that is a real answer, and must never render as "0 of 0".

import type { Task, TaskStep } from "./api";

/** Just the steps, tolerating the field being absent on older rows. */
function steps(task: Pick<Task, "steps">): TaskStep[] {
  return task.steps ?? [];
}

/** How far along, when the task says so. `null` when the task has no plan —
 *  the caller must render nothing in that case, not "0 of 0". */
export function stepProgress(
  task: Pick<Task, "steps">,
): { done: number; total: number } | null {
  const s = steps(task);
  if (s.length === 0) return null;
  return { done: s.filter((x) => x.done).length, total: s.length };
}

/** "3 of 7", or `null` when there is no plan. The compact form the board
 *  card and list row wear. */
export function stepProgressLabel(task: Pick<Task, "steps">): string | null {
  const p = stepProgress(task);
  return p ? `${p.done} of ${p.total}` : null;
}

/** The step the work is on now: the first one not yet ticked. `null` when the
 *  task has no plan, or when every step is already done (nothing left to be
 *  "on"). The number is 1-based position, so a plan with two ticked steps is
 *  "on" step 3 even if a later step was ticked out of order — position is what
 *  a reader can point at. */
export function currentStep(
  task: Pick<Task, "steps">,
): { number: number; total: number; text: string } | null {
  const s = steps(task);
  if (s.length === 0) return null;
  const idx = s.findIndex((x) => !x.done);
  if (idx === -1) return null;
  return { number: idx + 1, total: s.length, text: s[idx].text };
}

/** "Step 3 of 7 — wire the model picker to the place": the whole-sentence story
 *  the crew graph tells over a working node. `null` when there is no plan to
 *  report (the caller falls back to a generic sentence) or the plan is fully
 *  ticked. A step whose text is blank drops the em-dash tail rather than
 *  trailing an empty clause. */
export function currentStepStory(task: Pick<Task, "steps">): string | null {
  const c = currentStep(task);
  if (!c) return null;
  const head = `Step ${c.number} of ${c.total}`;
  const tail = c.text.trim();
  return tail ? `${head} — ${tail}` : head;
}
