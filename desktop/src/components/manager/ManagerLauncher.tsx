// Modal flow for staging a new Manager session. Two paths:
//   - "Discover with Aura": shells `aura plan "<objective>"` then parses
//     `.aura/plans/ACTIVE_MILESTONE.xml` into a DraftTask[] so the user
//     gets the orchestrator-decomposed wave plan instead of typing
//     tasks by hand. Each wave's <action> becomes a task description;
//     dependencies chain wave[i] -> wave[i-1] so they execute in order.
//   - Manual: user types tasks directly. Same DAG shape afterwards.
//
// 4C addition: each task can target a different project drawn from the
// `~/.aura/projects.json` registry. The session's `projects` list is
// derived from the unique set of `project_root` values across tasks so
// the renderer doesn't have to manage that bookkeeping by hand.

import { useEffect, useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  api,
  type AgentInfo,
  type ManagerTaskSpec,
  type ProjectEntry,
} from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import "../ui/run-launcher.css";
import { parseWaves } from "./planWaves";

type Props = {
  open: boolean;
  onClose: () => void;
  defaultProjectRoot: string;
  onLaunched: (sessionId: string, label: string) => void;
  /** Stage 7C: when set, the objective field is pre-populated. The
   *  caller (PRDetailPane → "Convert to Plan") composes this from
   *  selected PR comment bodies + their file/line context. */
  seedObjective?: string;
};

type DraftTask = {
  description: string;
  agent_id: string;
  depends_on: string;
  project_root: string;
  zones: string;
};

function emptyTask(defaultRoot: string): DraftTask {
  return {
    description: "",
    agent_id: "",
    depends_on: "",
    project_root: defaultRoot,
    zones: "",
  };
}

export function ManagerLauncher({
  open,
  onClose,
  defaultProjectRoot,
  onLaunched,
  seedObjective,
}: Props) {
  const [objective, setObjective] = useState(seedObjective ?? "");
  const [tasks, setTasks] = useState<DraftTask[]>([emptyTask(defaultProjectRoot)]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Discover phase has its own busy + status so the user sees the
  // orchestrator working without disabling the rest of the dialog.
  const [discovering, setDiscovering] = useState(false);
  /** How many steps Aura's plan came back with, once it has. */
  const [planSteps, setPlanSteps] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    api.agentDiscover().then(setAgents).catch(() => setAgents([]));
    api.projectsList().then(setProjects).catch(() => setProjects([]));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setObjective("");
      setTasks([emptyTask(defaultProjectRoot)]);
      setError(null);
      setBusy(false);
      setDiscovering(false);
      setPlanSteps(null);
    } else if (seedObjective) {
      // Re-seed every time the modal opens so callers can re-use the
      // same launcher with different starting objectives (e.g. multiple
      // PR-comment conversions in one session).
      setObjective(seedObjective);
    }
  }, [open, defaultProjectRoot, seedObjective]);

  const discover = async () => {
    if (!objective.trim() || discovering) return;
    setError(null);
    setDiscovering(true);
    setPlanSteps(null);
    try {
      // `aura plan` writes the wave plan to `.aura/plans/ACTIVE_MILESTONE.xml`
      // and runs the parallel research pass internally. Headless mode
      // takes the parallel + atomic-commit defaults so we don't need
      // dialoguer prompts here.
      const planRun = await api.auraCli(defaultProjectRoot, ["plan", objective.trim()]);
      if (planRun.status !== 0) {
        const stderr = (planRun.stderr || "").trim();
        throw new Error(stderr || `aura plan exited with status ${planRun.status}`);
      }
      const planPath = `${defaultProjectRoot}/.aura/plans/ACTIVE_MILESTONE.xml`;
      const body = await api.readFile(planPath);
      if (body.status !== "ok" || !body.text) {
        throw new Error(
          "Plan ran but no ACTIVE_MILESTONE.xml was written. Try a more specific objective.",
        );
      }
      const waves = parseWaves(body.text);
      if (waves.length === 0) {
        throw new Error("No waves parsed from the plan output.");
      }
      const drafts: DraftTask[] = waves.map((w, idx) => ({
        description: w.action + (w.verify ? `\n. Verify: ${w.verify}` : ""),
        agent_id: "", // Smart pick — registry routes per task
        depends_on: idx === 0 ? "" : String(idx),
        project_root: defaultProjectRoot,
        zones: w.zones.join(", "),
      }));
      setTasks(drafts);
      setPlanSteps(waves.length);
    } catch (e) {
      setError(`Discover failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiscovering(false);
    }
  };

  // Project options surface the registry plus the active workspace if
  // it isn't registered yet (cold start). Dedupe by root.
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: { root: string; label: string }[] = [];
    if (defaultProjectRoot && !seen.has(defaultProjectRoot)) {
      seen.add(defaultProjectRoot);
      list.push({
        root: defaultProjectRoot,
        label: defaultProjectRoot.split("/").filter(Boolean).pop() ?? defaultProjectRoot,
      });
    }
    for (const p of projects) {
      if (!seen.has(p.root)) {
        seen.add(p.root);
        list.push({ root: p.root, label: p.label });
      }
    }
    return list;
  }, [projects, defaultProjectRoot]);

  const updateTask = (idx: number, patch: Partial<DraftTask>) => {
    setTasks((cur) => cur.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };
  const addTask = () => setTasks((cur) => [...cur, emptyTask(defaultProjectRoot)]);
  const removeTask = (idx: number) =>
    setTasks((cur) => cur.filter((_, i) => i !== idx));

  const launch = async () => {
    setError(null);
    if (!objective.trim()) {
      setError("Say what this run should get done first.");
      return;
    }
    const specs: ManagerTaskSpec[] = [];
    for (const [i, t] of tasks.entries()) {
      if (!t.description.trim()) {
        setError(`Task ${i + 1} needs a description.`);
        return;
      }
      const deps: number[] = t.depends_on
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
      const zones: string[] = t.zones
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      specs.push({
        description: t.description.trim(),
        agent_id: t.agent_id || null,
        depends_on: deps,
        project_root: t.project_root || defaultProjectRoot,
        zones,
      });
    }
    // Derive the session's project list from the unique roots so
    // multi-project sessions don't need a separate picker.
    const seen = new Set<string>();
    const sessionProjects: { root: string; label: string }[] = [];
    for (const s of specs) {
      if (!seen.has(s.project_root)) {
        seen.add(s.project_root);
        const known = projectOptions.find((p) => p.root === s.project_root);
        sessionProjects.push({
          root: s.project_root,
          label: known?.label ?? s.project_root,
        });
      }
    }
    setBusy(true);
    try {
      const sid = await api.managerStart({
        objective: objective.trim(),
        projects: sessionProjects,
        tasks: specs,
      });
      onLaunched(sid, objective.trim().slice(0, 40));
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Orchestrate a multi-step session"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={launch} disabled={busy}>
            {busy ? "Staging…" : "Stage plan"}
          </Button>
        </>
      }
    >
      <div className="ui-launcher">
        <section className="ui-form-field">
          <div className="ui-launcher-head">
            <span id="launcher-objective">Objective</span>
            <Button
              variant="outline"
              size="sm"
              onClick={discover}
              disabled={!objective.trim() || discovering || busy}
              title="Have Aura break this down into steps, and work out which ones can run at the same time"
            >
              {discovering ? (
                <>
                  <AsciiSpinner />
                  Aura is planning…
                </>
              ) : (
                "Discover with Aura"
              )}
            </Button>
          </div>
          <Textarea
            rows={3}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            aria-labelledby="launcher-objective"
            placeholder="What should this session get done? Discover hands it to Aura, which splits it into steps, suggests an agent for each and chains them in order."
          />
        </section>

        {planSteps != null && (
          <p className="ui-launcher-plan" role="status">
            <Check aria-hidden />
            Aura split this into {planSteps} {planSteps === 1 ? "step" : "steps"}. Change
            any of them below before staging.
          </p>
        )}

        <section className="ui-launcher-tasks-section">
          <div className="ui-launcher-head">
            <span id="launcher-tasks">Tasks</span>
            <Button variant="ghost" size="sm" onClick={addTask}>
              <Plus />
              Add task
            </Button>
          </div>
          <ol className="ui-launcher-tasks" aria-labelledby="launcher-tasks">
            {tasks.map((t, idx) => (
              <li key={idx} className="ui-launcher-task">
                <div className="ui-launcher-task-line">
                  <span className="ui-launcher-task-no">{idx + 1}</span>
                  <Input
                    value={t.description}
                    onChange={(e) => updateTask(idx, { description: e.target.value })}
                    placeholder="What this step does"
                    aria-label={`Task ${idx + 1}`}
                  />
                  {tasks.length > 1 && (
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => removeTask(idx)}
                      aria-label={`Remove task ${idx + 1}`}
                      title="Remove this task"
                    >
                      <X />
                    </Button>
                  )}
                </div>
                <div className="ui-launcher-task-options">
                  <Select
                    value={t.agent_id}
                    onChange={(v) => updateTask(idx, { agent_id: v })}
                    aria-label={`Agent for task ${idx + 1}`}
                    options={[
                      { value: "", label: "Smart pick" },
                      ...agents.map((a) => ({ value: a.id, label: a.label })),
                    ]}
                  />
                  <Select
                    value={t.project_root}
                    onChange={(v) => updateTask(idx, { project_root: v })}
                    aria-label={`Repository for task ${idx + 1}`}
                    options={projectOptions.map((p) => ({
                      value: p.root,
                      label: p.label,
                    }))}
                  />
                  <Input
                    value={t.depends_on}
                    onChange={(e) => updateTask(idx, { depends_on: e.target.value })}
                    placeholder="After tasks (e.g. 1, 2)"
                    aria-label={`Tasks that must finish before task ${idx + 1}`}
                  />
                  <Input
                    value={t.zones}
                    onChange={(e) => updateTask(idx, { zones: e.target.value })}
                    placeholder="Folders it owns (e.g. src/auth)"
                    aria-label={`Folders task ${idx + 1} owns`}
                    title="Comma-separated paths claimed before it starts, so no other step edits them"
                  />
                </div>
              </li>
            ))}
          </ol>
        </section>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
