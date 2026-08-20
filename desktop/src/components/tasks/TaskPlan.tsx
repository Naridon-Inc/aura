// TaskPlan — the ordered checklist a task's plan renders as on the detail
// pane. Every line a crew agent (or a human) wrote is tickable here; ticking
// one calls `api.tasksStepSet` by POSITION, not by resending the whole list,
// so a human rewording the plan and an agent finishing a step can't clobber
// each other (see cmd_tasks.rs::tasks_step_set).
//
// Compact rows, no cards — a numbered line, a checkbox, the text. The header
// carries the live "3 of 7" and a hairline progress bar so the reader sees
// where the work got to without counting. Renders nothing when the task has
// no plan; the detail pane drops the whole section in that case, so this
// never shows an empty "0 of 0".

import { useState, type JSX } from "react";

import type { Task } from "../../lib/api";
import { stepProgress } from "../../lib/taskSteps";
import { Checkbox } from "../ui/checkbox";
import { toast } from "../../lib/toast";

export function TaskPlan({
  task,
  onStepSet,
}: {
  task: Task;
  /** Tick step `index` on/off. Resolves once the board has the change; the
   *  parent owns the write (api.tasksStepSet) and the refetch. */
  onStepSet: (index: number, done: boolean) => Promise<void>;
}): JSX.Element | null {
  const steps = task.steps ?? [];
  const progress = stepProgress(task);
  // No plan → nothing. The pane guards the section divider on the same
  // condition, so this component and its heading vanish together.
  if (!progress || steps.length === 0) return null;

  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;

  return (
    <section aria-label="Plan">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-medium text-text-2">Plan</h3>
        <span className="text-xs tabular-nums text-text-4">
          {progress.done} of {progress.total}
        </span>
        <div
          className="ml-auto h-1 w-24 rounded-full bg-line-soft overflow-hidden"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-label={`${progress.done} of ${progress.total} steps done`}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <ol className="flex flex-col gap-0.5">
        {steps.map((step, i) => (
          <PlanRow
            key={i}
            index={i}
            text={step.text}
            done={step.done}
            onStepSet={onStepSet}
          />
        ))}
      </ol>
    </section>
  );
}

// One line of the plan. Owns just enough local state to disable itself while
// its own toggle is in flight (so a double-click can't fire two writes at the
// same position) and to surface a failure without losing the click.
function PlanRow({
  index,
  text,
  done,
  onStepSet,
}: {
  index: number;
  text: string;
  done: boolean;
  onStepSet: (index: number, done: boolean) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onStepSet(index, !done);
    } catch (e) {
      toast.danger("Couldn't update the plan", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <label
        className={`group flex items-start gap-2.5 rounded-md px-2 py-1.5 -mx-2 cursor-pointer transition-colors hover:bg-state-hover ${
          busy ? "opacity-60" : ""
        }`}
      >
        <span className="mt-0.5 w-4 text-right text-xs tabular-nums text-text-5 select-none">
          {index + 1}
        </span>
        <Checkbox
          checked={done}
          disabled={busy}
          onCheckedChange={() => void toggle()}
          className="mt-0.5 flex-shrink-0"
          aria-label={done ? `Undo step ${index + 1}` : `Complete step ${index + 1}`}
        />
        <span
          className={`text-sm leading-snug ${
            done ? "text-text-4 line-through" : "text-text-1"
          }`}
        >
          {text || <span className="italic text-text-5">Untitled step</span>}
        </span>
      </label>
    </li>
  );
}
