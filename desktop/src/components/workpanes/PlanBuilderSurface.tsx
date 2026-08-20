// Plan Builder — singleton wizard surface.
//
// Walks the user from a free-form goal to a wave/task plan committed to
// `.aura/plans/ACTIVE_MILESTONE.xml`. Replaces the cramped textarea
// inside PlanSidebar's <EmptyPlan>. Five tightly-packed steps:
//
//   ① Goal      — what do you want built (textarea + recent goals)
//   ② Context   — show the project the planner will reason over
//   ③ Decisions — V1 stub: planner makes its own choices headless
//   ④ Plan      — editable wave/task tree from `aura plan <goal>` --json
//   ⑤ Launch    — Save (already on disk) or Send to Aura Manager
//
// Compact UX: 12-13px body, 10-11px hints, no card chrome, single
// 320-560px content column, dense footer. Designed to feel like a
// focused composer, not a settings dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ManagerTaskSpec, type ProjectRef } from "../../lib/api";
import { focusAmbientManager } from "../../lib/focusManager";
import { parsePlanXml, type ParsedPlan } from "../../lib/planXml";
import { AgentIcon } from "../agent/AgentIcon";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { useDismiss } from "../../lib/useDismiss";
import { basename } from "../../lib/paths";

type Props = { repoRoot: string; onClose: () => void };

type StepId = 1 | 2 | 3 | 4 | 5;

type StepDef = { id: StepId; label: string };

const STEPS: StepDef[] = [
  { id: 1, label: "Goal" },
  { id: 2, label: "Context" },
  { id: 3, label: "Decisions" },
  { id: 4, label: "Plan" },
  { id: 5, label: "Launch" },
];

const KNOWN_AGENTS: Array<{ id: string; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "aura-manager", label: "Aura" },
];

export function PlanBuilderSurface({ repoRoot, onClose }: Props) {
  const [step, setStep] = useState<StepId>(1);
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ParsedPlan | null>(null);
  const [editedPlan, setEditedPlan] = useState<EditablePlan | null>(null);
  const [launching, setLaunching] = useState<"none" | "save" | "manager">("none");
  const [launchError, setLaunchError] = useState<string | null>(null);

  const projectLabel = useMemo(() => basename(repoRoot), [repoRoot]);

  // Trigger `aura plan <goal>` when entering step 4 if the plan hasn't
  // been generated yet (or the goal changed since last generation).
  const lastPlannedGoal = useRef<string>("");
  useEffect(() => {
    if (step !== 4) return;
    if (!goal.trim()) return;
    if (planning) return;
    if (plan && lastPlannedGoal.current === goal.trim()) return;
    runPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, goal]);

  const runPlan = useCallback(async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      const r = await api.auraCli(repoRoot, ["plan", goal.trim()]);
      if (r.status !== 0) {
        throw new Error(r.stderr.trim() || r.stdout.trim() || `aura exit ${r.status}`);
      }
      const xmlPath = `${repoRoot}/.aura/plans/ACTIVE_MILESTONE.xml`;
      const file = await api.readFile(xmlPath);
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
  }, [repoRoot, goal]);

  const next = () => setStep((s) => (s < 5 ? ((s + 1) as StepId) : s));
  const back = () => setStep((s) => (s > 1 ? ((s - 1) as StepId) : s));

  const canContinue =
    step === 1
      ? goal.trim().length > 3
      : step === 4
        ? !planning && !!plan && (plan.waves.length ?? 0) > 0
        : true;

  const launchSavePlan = async () => {
    // `aura plan` already wrote ACTIVE_MILESTONE.xml. If the user edited
    // wave/task names or agents, write the edited version back.
    if (!editedPlan) {
      onClose();
      return;
    }
    setLaunching("save");
    setLaunchError(null);
    try {
      const xml = serializePlan(editedPlan, goal.trim());
      const xmlPath = `${repoRoot}/.aura/plans/ACTIVE_MILESTONE.xml`;
      await api.writeFile(xmlPath, xml);
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
      const xml = serializePlan(editedPlan, goal.trim());
      await api.writeFile(`${repoRoot}/.aura/plans/ACTIVE_MILESTONE.xml`, xml);
      const projects: ProjectRef[] = [{ root: repoRoot, label: projectLabel }];
      const tasks: ManagerTaskSpec[] = [];
      let id = 0;
      for (const wave of editedPlan.waves) {
        for (const t of wave.tasks) {
          id += 1;
          tasks.push({
            description: t.description?.trim()
              ? `${t.name}\n\n${t.description}`
              : t.name,
            agent_id: t.agent || null,
            project_root: repoRoot,
          });
        }
      }
      const sid = await api.managerStart({
        objective: goal.trim(),
        projects,
        tasks,
      });
      focusAmbientManager(repoRoot, sid);
      onClose();
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching("none");
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <Header step={step} onClose={onClose} />
      <Stepper current={step} onJump={(s) => setStep(s)} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div
          className="mx-auto py-3 px-4"
          style={{ maxWidth: 560 }}
        >
          {step === 1 && (
            <GoalStep value={goal} onChange={setGoal} repoRoot={repoRoot} />
          )}
          {step === 2 && <ContextStep repoRoot={repoRoot} projectLabel={projectLabel} />}
          {step === 3 && <DecisionsStep />}
          {step === 4 && (
            <PlanStep
              planning={planning}
              error={planError}
              plan={editedPlan}
              onRetry={runPlan}
              onMutate={setEditedPlan}
            />
          )}
          {step === 5 && (
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
        </div>
      </div>
      <Footer
        step={step}
        canContinue={canContinue}
        planning={planning}
        onBack={back}
        onContinue={next}
        onClose={onClose}
      />
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────

function Header({ step, onClose }: { step: StepId; onClose: () => void }) {
  return (
    <div className="flex items-center h-9 px-3 border-b border-line-soft flex-shrink-0">
      <span className="text-text-1 text-sm font-medium">Plan a feature</span>
      <span className="ml-2 text-text-4 text-xs tabular-nums">
        Step {step}/5
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        title="Close"
        className="ml-auto text-text-4 hover:text-text-1 text-md"
      >
        ×
      </Button>
    </div>
  );
}

// ── Stepper (clickable pill row) ──────────────────────────────────────

function Stepper({
  current,
  onJump,
}: {
  current: StepId;
  onJump: (s: StepId) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3 h-7 bg-bg-1 border-b border-line-soft flex-shrink-0">
      {STEPS.map((s, i) => {
        const active = current === s.id;
        const done = current > s.id;
        return (
          <div key={s.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onJump(s.id)}
              className={`flex items-center gap-1 h-5 px-1.5 rounded text-xs transition-colors ${
                active
                  ? "bg-bg-3 text-text-1 font-medium"
                  : done
                    ? "text-text-2 hover:text-text-1 hover:bg-state-hover"
                    : "text-text-4 hover:text-text-2 hover:bg-state-hover"
              }`}
            >
              <span className="font-mono w-3 text-center tabular-nums">{s.id}</span>
              <span>{s.label}</span>
            </button>
            {i < STEPS.length - 1 && (
              <span className="text-text-5 text-2xs">›</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Footer ────────────────────────────────────────────────────────────

function Footer({
  step,
  canContinue,
  planning,
  onBack,
  onContinue,
  onClose,
}: {
  step: StepId;
  canContinue: boolean;
  planning: boolean;
  onBack: () => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  const continueLabel = planning
    ? "thinking…"
    : step === 4
      ? "Looks good"
      : step === 5
        ? "Done"
        : "Continue";
  const handleContinue = () => {
    if (step === 5) onClose();
    else onContinue();
  };
  return (
    <div className="flex items-center justify-between h-9 px-3 border-t border-line-soft bg-bg-1 flex-shrink-0">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onClose}
          className="text-xs text-text-3 hover:text-text-1"
        >
          Cancel
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        {step > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onBack}
            className="px-2.5 text-xs text-text-2 hover:text-text-1"
          >
            Back
          </Button>
        )}
        <button
          type="button"
          onClick={handleContinue}
          disabled={!canContinue || planning}
          className="px-3 h-6 rounded text-xs font-medium bg-bg-3 hover:bg-state-hover text-text-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {continueLabel}
        </button>
      </div>
    </div>
  );
}

// ── Step 1 — Goal ─────────────────────────────────────────────────────

function GoalStep({
  value,
  onChange,
  repoRoot,
}: {
  value: string;
  onChange: (v: string) => void;
  repoRoot: string;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .readFile(`${repoRoot}/.aura/intent_log.jsonl`)
      .then((f) => {
        if (cancelled) return;
        if (f.status !== "ok" || !f.text) return;
        const lines = f.text.trim().split(/\r?\n/).filter(Boolean).reverse();
        const out: string[] = [];
        for (const ln of lines) {
          try {
            const obj = JSON.parse(ln);
            const text = (obj.intent ?? obj.text ?? obj.summary ?? "").trim();
            if (text && text.length > 6 && !out.includes(text)) out.push(text);
          } catch {
            /* ignore */
          }
          if (out.length >= 4) break;
        }
        setRecent(out);
      })
      .catch(() => {
        /* no recent intents — fine */
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-text-2 text-sm">
        What do you want built?
      </label>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. add OAuth2 sign-in across the API"
        className="bg-bg-2 border border-line-soft rounded px-2.5 py-1.5 text-text-1 text-base resize-none focus:outline-none focus:border-line min-h-[80px] leading-snug"
      />
      <div className="text-text-4 text-xs">
        Aura splits this into atomic waves and tasks. Be concrete. Names
        of features, not full specs.
      </div>
      {recent.length > 0 && (
        <div className="flex flex-col gap-1 mt-2">
          <div className="section-label">
            Recent intents
          </div>
          {recent.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(r)}
              title={r}
              className="text-left px-2 py-1 rounded text-text-3 text-xs hover:text-text-1 hover:bg-state-hover truncate"
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Step 2 — Context ──────────────────────────────────────────────────

function ContextStep({
  repoRoot,
  projectLabel,
}: {
  repoRoot: string;
  projectLabel: string;
}) {
  const [info, setInfo] = useState<{ files: number; branch: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.gitStatusV2(repoRoot).catch(() => []),
      api.gitBranch(repoRoot).catch(() => "—"),
    ]).then(([entries, branch]) => {
      if (cancelled) return;
      setInfo({ files: entries.length, branch });
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-2 text-sm">
        Aura is reading your project.
      </div>
      <div className="flex items-center gap-2 text-xs text-text-3 px-2 py-1.5 bg-bg-2 rounded border border-line-soft">
        <span className="text-text-5">project</span>
        <span className="text-text-1 font-medium">{projectLabel}</span>
        <span className="ml-auto text-text-4 truncate" title={repoRoot}>
          {repoRoot}
        </span>
      </div>
      {info && (
        <div className="flex items-center gap-3 text-xs text-text-4 px-2">
          <span>branch: <span className="text-text-2">{info.branch}</span></span>
          <span>changed: <span className="text-text-2 tabular-nums">{info.files}</span></span>
        </div>
      )}
      <div className="text-text-4 text-xs mt-1 leading-relaxed">
        The planner walks your repo's semantic engine (file tree, recent
        commits, intent log, sentinel notes) to ground its plan in what
        you've actually built.
      </div>
    </div>
  );
}

// ── Step 3 — Decisions (V1 stub) ──────────────────────────────────────

function DecisionsStep() {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-2 text-sm">Design choices</div>
      <div className="px-2 py-2 rounded border border-line-soft bg-bg-2 text-xs text-text-3 leading-relaxed">
        Aura uses its own judgement on small design choices for this
        plan. You'll be able to review and edit every wave + task in the
        next step before anything runs.
      </div>
      <div className="text-text-4 text-xs mt-1">
        Coming next: the planner will surface 3 gray-area questions
        (e.g. "session storage: cookie vs JWT?") for you to answer
        before it locks the plan.
      </div>
    </div>
  );
}

// ── Step 4 — Plan (editable) ──────────────────────────────────────────

type EditableTask = {
  id: string;
  name: string;
  description: string;
  agent: string;
  dependencies: string[];
  priority: string;
  tags: string[];
};

type EditableWave = {
  id: string;
  name: string;
  tasks: EditableTask[];
};

type EditablePlan = { waves: EditableWave[] };

function toEditable(p: ParsedPlan): EditablePlan {
  return {
    waves: p.waves.map((w) => ({
      id: w.id,
      name: w.name,
      tasks: w.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        agent: "",
        dependencies: t.dependencies.slice(),
        priority: t.priority,
        tags: t.tags.slice(),
      })),
    })),
  };
}

function PlanStep({
  planning,
  error,
  plan,
  onRetry,
  onMutate,
}: {
  planning: boolean;
  error: string | null;
  plan: EditablePlan | null;
  onRetry: () => void;
  onMutate: (p: EditablePlan) => void;
}) {
  if (planning) {
    return (
      <div className="flex flex-col gap-2 py-4 items-center text-center">
        <AsciiSpinner className="text-base" />
        <div className="text-text-2 text-sm">Aura is decomposing your goal…</div>
        <div className="text-text-4 text-xs">
          Discover · Gray-area picks · Wave synthesis
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-rose-300 text-xs px-2 py-1.5 rounded bg-rose-500/10 border border-rose-500/30">
          {error}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="self-start px-2.5 h-6 rounded text-xs bg-bg-3 hover:bg-state-hover text-text-1 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!plan || plan.waves.length === 0) {
    return (
      <div className="text-text-3 text-sm">
        no plan yet. Go back and refine the goal
      </div>
    );
  }
  const updateTask = (waveIdx: number, taskIdx: number, patch: Partial<EditableTask>) => {
    const next: EditablePlan = {
      waves: plan.waves.map((w, wi) => {
        if (wi !== waveIdx) return w;
        return {
          ...w,
          tasks: w.tasks.map((t, ti) => (ti === taskIdx ? { ...t, ...patch } : t)),
        };
      }),
    };
    onMutate(next);
  };
  const removeTask = (waveIdx: number, taskIdx: number) => {
    const next: EditablePlan = {
      waves: plan.waves.map((w, wi) => {
        if (wi !== waveIdx) return w;
        return { ...w, tasks: w.tasks.filter((_, ti) => ti !== taskIdx) };
      }),
    };
    onMutate(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-2 text-sm">
        Edit any wave or task. Pin an agent to lock who picks it up.
      </div>
      {plan.waves.map((wave, wi) => (
        <div key={wave.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1 pt-1.5">
            <span className="text-text-4 text-2xs tabular-nums w-7">
              W{wi + 1}
            </span>
            <input
              value={wave.name}
              onChange={(e) => {
                const next: EditablePlan = {
                  waves: plan.waves.map((w, i) =>
                    i === wi ? { ...w, name: e.target.value } : w,
                  ),
                };
                onMutate(next);
              }}
              className="flex-1 bg-transparent text-text-1 text-sm font-medium px-1 py-0.5 rounded hover:bg-state-hover focus:outline-none focus:bg-state-hover"
            />
            <span className="text-text-4 text-2xs tabular-nums">
              {wave.tasks.length}
            </span>
          </div>
          {wave.tasks.map((task, ti) => (
            <TaskRow
              key={`${wave.id}-${task.id}-${ti}`}
              task={task}
              onChange={(patch) => updateTask(wi, ti, patch)}
              onRemove={() => removeTask(wi, ti)}
            />
          ))}
        </div>
      ))}
    </div>
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
  return (
    <div className="border border-line-soft rounded bg-bg-1">
      <div className="flex items-center gap-1.5 pl-2 pr-1 py-1">
        <input
          value={task.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="flex-1 bg-transparent text-text-1 text-sm px-1 py-0.5 rounded focus:outline-none focus:bg-state-hover"
        />
        {task.dependencies.length > 0 && (
          <span
            className="text-text-4 text-2xs font-mono tabular-nums"
            title={`Depends on: ${task.dependencies.join(", ")}`}
          >
            ⇠ {task.dependencies.length}
          </span>
        )}
        <AgentPicker value={task.agent} onChange={(a) => onChange({ agent: a })} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? "Collapse" : "Edit description"}
          className="w-5 h-5 rounded text-text-4 hover:text-text-1 hover:bg-state-hover text-2xs flex items-center justify-center"
        >
          {open ? "−" : "+"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove task"
          className="w-5 h-5 rounded text-text-4 hover:text-rose-300 hover:bg-state-hover text-sm flex items-center justify-center"
        >
          ×
        </button>
      </div>
      {open && (
        <div className="px-2 pb-1.5 pt-0">
          <textarea
            value={task.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Description (optional)"
            className="w-full bg-bg-2 border border-line-soft rounded px-2 py-1 text-xs text-text-2 resize-none focus:outline-none focus:border-line min-h-[44px] leading-snug"
          />
        </div>
      )}
    </div>
  );
}

function AgentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (agent: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const label = value ? KNOWN_AGENTS.find((a) => a.id === value)?.label ?? value : "any";
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={value ? `Pinned: ${label}` : "Pick agent"}
        className="flex items-center gap-1 h-5 px-1.5 rounded text-2xs text-text-3 hover:text-text-1 hover:bg-state-hover transition-colors"
      >
        {value ? <AgentIcon agentId={value} size={11} /> : <span className="text-text-5">·</span>}
        <span className="hidden sm:inline">{label}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-6 z-30 bg-bg-1 border border-line rounded-lg shadow-sm py-1 px-1"
          style={{ minWidth: 150 }}
        >
          {KNOWN_AGENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                onChange(a.id);
                setOpen(false);
              }}
              className={`w-full text-left flex items-center gap-2 px-2 py-1 rounded text-xs ${
                value === a.id
                  ? "bg-bg-2 text-text-1"
                  : "text-text-2 hover:bg-state-hover hover:text-text-1"
              }`}
            >
              <AgentIcon agentId={a.id} size={12} />
              <span>{a.label}</span>
            </button>
          ))}
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="w-full text-left px-2 py-1 rounded text-xs text-text-3 hover:bg-state-hover hover:text-text-1"
            >
              <span className="pl-[20px]">Clear</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step 5 — Launch ───────────────────────────────────────────────────

function LaunchStep({
  goal,
  plan,
  projectLabel,
  busy,
  error,
  onSave,
  onSend,
}: {
  goal: string;
  plan: EditablePlan | null;
  projectLabel: string;
  busy: "none" | "save" | "manager";
  error: string | null;
  onSave: () => void;
  onSend: () => void;
}) {
  const taskCount = (plan?.waves ?? []).reduce((n, w) => n + w.tasks.length, 0);
  const waveCount = plan?.waves.length ?? 0;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5 px-2 py-2 rounded border border-line-soft bg-bg-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-5">goal</span>
          <span className="text-text-1 truncate" title={goal}>
            {goal}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-4">
          <span>project: <span className="text-text-2">{projectLabel}</span></span>
          <span>·</span>
          <span><span className="text-text-2 tabular-nums">{waveCount}</span> waves</span>
          <span>·</span>
          <span><span className="text-text-2 tabular-nums">{taskCount}</span> tasks</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={busy !== "none" || !plan}
          onClick={onSave}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-1 hover:bg-state-hover text-left disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <span className="text-text-4 text-2xs font-mono w-3">▸</span>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-text-1 text-sm font-medium">
              {busy === "save" ? "saving…" : "Save plan"}
            </span>
            <span className="text-text-4 text-xs">
              Writes to .aura/plans/ACTIVE_MILESTONE.xml. Run later from
              Plan sidebar.
            </span>
          </div>
        </button>
        <button
          type="button"
          disabled={busy !== "none" || !plan}
          onClick={onSend}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line bg-bg-3 hover:bg-state-hover text-left disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <span className="text-text-4 text-2xs font-mono w-3">▸</span>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-text-1 text-sm font-medium">
              {busy === "manager" ? "starting Aura…" : "Send to Aura"}
            </span>
            <span className="text-text-4 text-xs">
              Saves the plan and opens a Manager session ready to dispatch
              tasks to the agents you pinned.
            </span>
          </div>
        </button>
      </div>

      {error && (
        <div className="text-rose-300 text-xs px-2 py-1.5 rounded bg-rose-500/10 border border-rose-500/30">
          {error}
        </div>
      )}
    </div>
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializePlan(plan: EditablePlan, objective: string): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<milestone>`);
  out.push(`  <objective>${escapeXml(objective)}</objective>`);
  out.push(`  <plan>`);
  for (const wave of plan.waves) {
    out.push(`    <wave id="${escapeXml(wave.id)}" name="${escapeXml(wave.name)}">`);
    for (const t of wave.tasks) {
      out.push(`      <task id="${escapeXml(t.id)}" name="${escapeXml(t.name)}">`);
      if (t.description.trim()) {
        out.push(`        <description>${escapeXml(t.description.trim())}</description>`);
      }
      if (t.agent) out.push(`        <owner>${escapeXml(t.agent)}</owner>`);
      if (t.priority) out.push(`        <priority>${escapeXml(t.priority)}</priority>`);
      if (t.dependencies.length > 0) {
        out.push(`        <dependencies>`);
        for (const d of t.dependencies) {
          out.push(`          <dependency>${escapeXml(d)}</dependency>`);
        }
        out.push(`        </dependencies>`);
      }
      if (t.tags.length > 0) {
        out.push(`        <tags>`);
        for (const tag of t.tags) {
          out.push(`          <tag>${escapeXml(tag)}</tag>`);
        }
        out.push(`        </tags>`);
      }
      out.push(`      </task>`);
    }
    out.push(`    </wave>`);
  }
  out.push(`  </plan>`);
  out.push(`</milestone>`);
  return out.join("\n");
}

