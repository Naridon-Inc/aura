// The plan builder's fourth page: the waves and tasks Aura proposed, every
// name editable, any task removable, and an agent pinned to whichever task
// should go to someone in particular.

import { useState } from "react";
import { ChevronDown, ListTodo, X } from "lucide-react";
import { AgentIcon } from "../../agent/AgentIcon";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, type SelectOption } from "../../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";
import { Textarea } from "../../ui/textarea";
import { KNOWN_AGENTS, type EditablePlan, type EditableTask } from "./planModel";
import "../../ui/plan-builder.css";

const AGENT_OPTIONS: SelectOption[] = [
  { value: "", label: "Any agent" },
  ...KNOWN_AGENTS.map((a) => ({
    value: a.id,
    label: a.label,
    icon: <AgentIcon agentId={a.id} size={12} />,
  })),
];

export function PlanStep({
  planning,
  error,
  plan,
  onRetry,
  onBack,
  onMutate,
}: {
  planning: boolean;
  error: string | null;
  plan: EditablePlan | null;
  onRetry: () => void;
  /** Back to the goal, when there is nothing to plan yet. */
  onBack: () => void;
  onMutate: (p: EditablePlan) => void;
}) {
  if (planning) {
    return <LoadingState size="md" label="Splitting your goal into waves of tasks…" />;
  }
  if (error) {
    return (
      <ErrorState
        title="The plan didn't come together"
        message={error}
        onRetry={onRetry}
        size="sm"
      />
    );
  }
  if (!plan || plan.waves.length === 0) {
    return (
      <EmptyState
        icon={ListTodo}
        title="No plan yet"
        body="Say a little more about what you want built, and Aura will try again."
        action={{ label: "Back to the goal", onClick: onBack }}
      />
    );
  }

  const setWaves = (waves: EditablePlan["waves"]) => onMutate({ waves });
  const updateTask = (wi: number, ti: number, patch: Partial<EditableTask>) =>
    setWaves(
      plan.waves.map((w, i) =>
        i !== wi ? w : { ...w, tasks: w.tasks.map((t, j) => (j === ti ? { ...t, ...patch } : t)) },
      ),
    );
  const removeTask = (wi: number, ti: number) =>
    setWaves(
      plan.waves.map((w, i) => (i !== wi ? w : { ...w, tasks: w.tasks.filter((_, j) => j !== ti) })),
    );

  return (
    <>
      <header>
        <h1>Check the plan</h1>
        <p>
          Rename anything, drop what you don't need, and pick an agent for a task to choose who does
          it.
        </p>
      </header>
      <div className="ui-plan-waves">
        {plan.waves.map((wave, wi) => (
          <section key={wave.id} className="ui-plan-wave" aria-label={`Wave ${wi + 1}`}>
            <div className="ui-plan-wave-head">
              <span>Wave {wi + 1}</span>
              <Input
                size="small"
                value={wave.name}
                aria-label={`Name of wave ${wi + 1}`}
                onChange={(e) =>
                  setWaves(plan.waves.map((w, i) => (i === wi ? { ...w, name: e.target.value } : w)))
                }
              />
              <small>
                {wave.tasks.length} {wave.tasks.length === 1 ? "task" : "tasks"}
              </small>
            </div>
            {wave.tasks.length > 0 && (
              <ul className="ui-plan-tasks">
                {wave.tasks.map((task, ti) => (
                  <TaskRow
                    key={`${wave.id}-${task.id}-${ti}`}
                    task={task}
                    onChange={(patch) => updateTask(wi, ti, patch)}
                    onRemove={() => removeTask(wi, ti)}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function TaskRow({
  task,
  onChange,
  onRemove,
}: {
  task: EditableTask;
  onChange: (patch: Partial<EditableTask>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const waits = task.dependencies.length;
  return (
    <li className="ui-plan-task">
      <div className="ui-plan-task-row">
        <Input
          size="small"
          value={task.name}
          aria-label="Task"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {waits > 0 && (
          <small title={`Waits for ${task.dependencies.join(", ")}`}>
            after {waits} {waits === 1 ? "task" : "tasks"}
          </small>
        )}
        <Select
          value={task.agent}
          onChange={(agent) => onChange({ agent })}
          options={AGENT_OPTIONS}
          indicator="down"
          align="end"
          aria-label="Who does it"
          className="ui-plan-agent"
        />
        <Button
          variant="ghost"
          size="iconXs"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Details"}
          title={open ? "Hide details" : "Details"}
          onClick={() => setOpen((v) => !v)}
          className="ui-plan-task-more"
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Remove task"
          title="Remove task"
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {open && (
        <Textarea
          rows={2}
          value={task.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Details (optional)"
          aria-label="Task details"
        />
      )}
    </li>
  );
}
