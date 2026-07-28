// TaskGoals — the goals a task is assigned, on the task detail Overview.
//
// A goal here is the task's acceptance criterion in plain language ("users can
// reset their password"). It's the SAME GoalRecord a run proves: linking one to
// a task and proving one from a session both write to the one record, so the
// verdict a run produced surfaces right here on the task, and vice-versa. That
// is the "associated with both the task and the run" the model is built around.
//
// Setting a goal links it to this task; verifying it (here or from any run)
// records a verdict the rollup reads as reached / partly / not reached.

import type { Task } from "../../lib/api";
import {
  linkTask,
  unlinkTask,
  upsertGoalByText,
  useGoalsForTask,
} from "../../lib/goalStore";
import { GoalProbe } from "./GoalProbe";
import { GoalComposer } from "./GoalComposer";
import { FeatureRollup } from "./FeatureRollup";

export function TaskGoals({ repoRoot, task }: { repoRoot: string; task: Task }) {
  const goals = useGoalsForTask(repoRoot, task.id);

  function addForTask(text: string) {
    const goal = upsertGoalByText(repoRoot, text);
    linkTask(repoRoot, goal.id, task.id, task.sequence_id ?? null);
  }

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">Goals</h2>
        {goals.length > 0 ? (
          <span className="text-[11px] text-text-4">
            {goals.filter((g) => g.runs[0]?.verdict === "verified").length}/{goals.length} reached
          </span>
        ) : null}
      </div>

      {/* When a task holds several goals, they're one feature — roll them into a
          single "is it finished across all its sessions" read above the cards. */}
      <FeatureRollup repoRoot={repoRoot} goals={goals} />

      {goals.length > 0 ? (
        <div className="mb-2.5 flex flex-col gap-2">
          {goals.map((g) => (
            <GoalProbe
              key={g.id}
              repoRoot={repoRoot}
              goal={g}
              onRemove={() => unlinkTask(repoRoot, g.id)}
            />
          ))}
        </div>
      ) : (
        <p className="mb-2.5 text-[12.5px] leading-relaxed text-text-4">
          No goals on this task yet. Describe what &quot;done&quot; looks like and Aura
          checks whether the AI actually built it — from here, or from the run that does
          the work.
        </p>
      )}

      <GoalComposer
        prefill={task.title}
        placeholder="What does done look like for this task?"
        cta="Set a goal for this task"
        onSubmit={addForTask}
      />
    </section>
  );
}
