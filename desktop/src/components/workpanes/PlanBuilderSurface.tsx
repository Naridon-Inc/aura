// Plan builder — walks a goal to a wave/task plan saved in
// `.aura/plans/ACTIVE_MILESTONE.xml`, then hands it to Aura or keeps it for
// later. Five pages in the shared step flow:
//
//   Goal      — what to build (and recent work to start from)
//   Context   — the repository the planner will read
//   Decisions — the small design calls Aura makes on its own
//   Plan      — the waves and tasks `aura plan <goal>` proposed, editable
//   Launch    — send it to Aura, or save it for later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, type ManagerTaskSpec, type ProjectRef } from "../../lib/api";
import { focusAmbientManager } from "../../lib/focusManager";
import { parsePlanXml, type ParsedPlan } from "../../lib/planXml";
import { basename } from "../../lib/paths";
import { Button } from "../ui/button";
import { SetupFlow } from "../ui/setup-flow";
import { ContextStep, DecisionsStep, GoalStep } from "./planBuilder/IntroSteps";
import { LaunchStep } from "./planBuilder/LaunchStep";
import { PlanStep } from "./planBuilder/PlanStep";
import { serializePlan, toEditable, type EditablePlan } from "./planBuilder/planModel";
import "../ui/plan-builder.css";

type Props = { repoRoot: string; onClose: () => void };

const STEPS = ["Goal", "Context", "Decisions", "Plan", "Launch"];
const GOAL = 0;
const PLAN = 3;
const LAUNCH = 4;

export function PlanBuilderSurface({ repoRoot, onClose }: Props) {
  const [step, setStep] = useState(GOAL);
  const [furthest, setFurthest] = useState(GOAL);
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ParsedPlan | null>(null);
  const [editedPlan, setEditedPlan] = useState<EditablePlan | null>(null);
  const [launching, setLaunching] = useState<"none" | "save" | "manager">("none");
  const [launchError, setLaunchError] = useState<string | null>(null);

  const projectLabel = useMemo(() => basename(repoRoot), [repoRoot]);
  const planPath = `${repoRoot}/.aura/plans/ACTIVE_MILESTONE.xml`;

  // The goal the current plan was made for.
  const lastPlannedGoal = useRef<string>("");
  const runPlan = useCallback(async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      const r = await api.auraCli(repoRoot, ["plan", goal.trim()]);
      if (r.status !== 0) {
        throw new Error(r.stderr.trim() || r.stdout.trim() || `aura exit ${r.status}`);
      }
      const file = await api.readFile(planPath);
      if (file.status !== "ok" || !file.text) {
        throw new Error("plan file missing after aura plan");
      }
      const parsed = parsePlanXml(file.text);
      setPlan(parsed);
      setEditedPlan(toEditable(parsed));
      lastPlannedGoal.current = goal.trim();
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }, [repoRoot, goal, planPath]);

  // Plan the goal when the Plan page opens, unless this goal is already
  // planned — going back to look at the context shouldn't re-plan.
  useEffect(() => {
    if (step !== PLAN || !goal.trim() || planning) return;
    if (plan && lastPlannedGoal.current === goal.trim()) return;
    runPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, goal]);

  const go = (next: number) => {
    setStep(next);
    setFurthest((f) => Math.max(f, next));
  };

  const canContinue =
    step === GOAL
      ? goal.trim().length > 3
      : step === PLAN
        ? !planning && !!plan && plan.waves.length > 0
        : true;
  const next = () => {
    if (canContinue && step < LAUNCH) go(step + 1);
  };

  const launchSavePlan = async () => {
    // `aura plan` already wrote the file; write it again only to keep the
    // names, agents and details changed on the Plan page.
    if (!editedPlan) {
      onClose();
      return;
    }
    setLaunching("save");
    setLaunchError(null);
    try {
      await api.writeFile(planPath, serializePlan(editedPlan, goal.trim()));
      onClose();
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching("none");
    }
  };

  const launchManager = async () => {
    if (!editedPlan) return;
    setLaunching("manager");
    setLaunchError(null);
    try {
      await api.writeFile(planPath, serializePlan(editedPlan, goal.trim()));
      const projects: ProjectRef[] = [{ root: repoRoot, label: projectLabel }];
      const tasks: ManagerTaskSpec[] = [];
      for (const wave of editedPlan.waves) {
        for (const t of wave.tasks) {
          tasks.push({
            description: t.description?.trim() ? `${t.name}\n\n${t.description}` : t.name,
            agent_id: t.agent || null,
            project_root: repoRoot,
          });
        }
      }
      const sid = await api.managerStart({ objective: goal.trim(), projects, tasks });
      focusAmbientManager(repoRoot, sid);
      onClose();
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching("none");
    }
  };

  return (
    <SetupFlow
      label="Plan steps"
      steps={STEPS}
      step={step}
      furthest={furthest}
      onStep={setStep}
      className="ui-plan-builder"
    >
      {step === GOAL && (
        <GoalStep value={goal} onChange={setGoal} onSubmit={next} repoRoot={repoRoot} />
      )}
      {step === 1 && <ContextStep repoRoot={repoRoot} projectLabel={projectLabel} />}
      {step === 2 && <DecisionsStep />}
      {step === PLAN && (
        <PlanStep
          planning={planning}
          error={planError}
          plan={editedPlan}
          onRetry={runPlan}
          onBack={() => setStep(GOAL)}
          onMutate={setEditedPlan}
        />
      )}
      {step === LAUNCH && (
        <LaunchStep
          goal={goal}
          plan={editedPlan}
          projectLabel={projectLabel}
          busy={launching}
          error={launchError}
          onSave={launchSavePlan}
          onSend={launchManager}
        />
      )}
      <div className="ui-cloud-inline">
        {step < LAUNCH && (
          <Button disabled={!canContinue || planning} onClick={next}>
            {step === PLAN ? "Looks good" : "Continue"} <ArrowRight />
          </Button>
        )}
        {step === GOAL && (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )}
      </div>
    </SetupFlow>
  );
}
