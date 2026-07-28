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
import { Dialog } from "../Dialog";
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

type ParsedWave = {
  action: string;
  verify: string;
  zones: string[];
};

// `aura plan` emits each wave as `<wave> <action>…</action> <verify>…
// </verify> [<file>…</file>]* </wave>`. The CLI's own runner uses the
// same line-walk strategy (gsd::execute_wave) so we mirror it here:
// pair an <action> with the next <verify>, capture <file> tags as zone
// hints. Tolerant to whitespace + reordering within a wave block.
function parseWaves(xml: string): ParsedWave[] {
  const out: ParsedWave[] = [];
  let action = "";
  let verify = "";
  let zones: string[] = [];
  const flush = () => {
    if (action) {
      out.push({ action: decode(action), verify: decode(verify), zones });
    }
    action = "";
    verify = "";
    zones = [];
  };
  // Strip CDATA wrappers and HTML entities while keeping the inner text.
  for (const raw of xml.split(/\r?\n/)) {
    const line = raw.trim();
    const a = matchTag(line, "action");
    if (a !== null) {
      // New action — flush any prior wave that had only an action with
      // no verify so we don't lose it.
      if (action && verify) flush();
      action = a;
      continue;
    }
    const v = matchTag(line, "verify");
    if (v !== null) {
      verify = v;
      // Action+verify together complete a wave.
      if (action) flush();
      continue;
    }
    const f = matchTag(line, "file") ?? matchTag(line, "path");
    if (f) zones.push(f);
  }
  if (action) flush();
  return out;
}

function matchTag(line: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = line.indexOf(open);
  if (i < 0) return null;
  const j = line.indexOf(close, i + open.length);
  if (j < 0) return null;
  return line.slice(i + open.length, j).trim();
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
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
  const [planSummary, setPlanSummary] = useState<{
    waveCount: number;
    estTokensSaved: number;
  } | null>(null);

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
      setPlanSummary(null);
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
    setPlanSummary(null);
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
        description: w.action + (w.verify ? `\n— Verify: ${w.verify}` : ""),
        agent_id: "", // Smart pick — registry routes per task
        depends_on: idx === 0 ? "" : String(idx),
        project_root: defaultProjectRoot,
        zones: w.zones.join(", "),
      }));
      setTasks(drafts);
      // Rough token-savings heuristic: each task hides the full objective
      // context behind a compressed handover (~250 tokens vs the full
      // codebase context an unstructured prompt would carry).
      setPlanSummary({
        waveCount: waves.length,
        estTokensSaved: Math.max(0, (waves.length - 1) * 1800),
      });
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
      setError("Objective required.");
      return;
    }
    const specs: ManagerTaskSpec[] = [];
    for (const [i, t] of tasks.entries()) {
      if (!t.description.trim()) {
        setError(`Task ${i + 1} missing description.`);
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
    <Dialog open={open} title="New Manager session" onClose={onClose} width={680}>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-text-3">Objective</label>
            <button
              type="button"
              onClick={discover}
              disabled={!objective.trim() || discovering || busy}
              title="Run `aura plan` to decompose this objective into wave/task DAG"
              className="text-[11px] px-2 h-6 rounded inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                color: "var(--color-accent)",
                border: "1px solid color-mix(in srgb, var(--color-accent) 32%, transparent)",
              }}
            >
              {discovering ? (
                <>
                  <AsciiSpinner />
                  Aura is planning…
                </>
              ) : (
                <>Discover with Aura</>
              )}
            </button>
          </div>
          <textarea
            className="w-full bg-bg-3 text-text-1 text-sm rounded border border-line-soft px-2 py-1.5 outline-none focus:border-line"
            rows={2}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What should this Manager session accomplish? Discover hands the objective to Aura's orchestrator — it'll decompose into atomic waves, suggest agents, and chain them with dependencies."
          />
        </div>
        {planSummary && (
          <div
            className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded"
            style={{
              background: "color-mix(in srgb, var(--color-accent-green) 9%, transparent)",
              color: "var(--color-accent-green)",
              border:
                "1px solid color-mix(in srgb, var(--color-accent-green) 25%, transparent)",
            }}
          >
            <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 12, height: 12 }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6.5l2.5 2.5 5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="text-text-1">
              Aura decomposed into <b>{planSummary.waveCount} waves</b>.
            </span>
            <span className="ml-auto text-text-3 tabular-nums">
              ≈ {planSummary.estTokensSaved.toLocaleString()} tokens saved per
              full re-prompt
            </span>
          </div>
        )}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-3">Tasks</span>
            <button
              className="text-xs text-text-3 hover:text-text-1"
              onClick={addTask}
            >
              + Add task
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {tasks.map((t, idx) => (
              <div
                key={idx}
                className="bg-bg-3 rounded border border-line-soft p-2 flex flex-col gap-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-3 w-6">#{idx + 1}</span>
                  <input
                    className="flex-1 bg-transparent text-sm text-text-1 outline-none"
                    value={t.description}
                    onChange={(e) => updateTask(idx, { description: e.target.value })}
                    placeholder="Task description"
                  />
                  {tasks.length > 1 && (
                    <button
                      className="text-xs text-text-3 hover:text-text-1"
                      onClick={() => removeTask(idx)}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <Select
                    className="w-auto min-w-[120px]"
                    value={t.agent_id}
                    onChange={(v) => updateTask(idx, { agent_id: v })}
                    aria-label="Agent"
                    options={[
                      { value: "", label: "Smart pick" },
                      ...agents.map((a) => ({ value: a.id, label: a.label })),
                    ]}
                  />
                  <Select
                    className="w-auto min-w-[120px]"
                    value={t.project_root}
                    onChange={(v) => updateTask(idx, { project_root: v })}
                    aria-label="Project"
                    options={projectOptions.map((p) => ({
                      value: p.root,
                      label: p.label,
                    }))}
                  />
                  <Input
                    className="flex-1 min-w-[100px]"
                    value={t.depends_on}
                    onChange={(e) => updateTask(idx, { depends_on: e.target.value })}
                    placeholder="Depends on (e.g. 1, 2)"
                  />
                  <Input
                    className="flex-1 min-w-[120px]"
                    value={t.zones}
                    onChange={(e) => updateTask(idx, { zones: e.target.value })}
                    placeholder="Zones (e.g. src/auth, src/db)"
                    title="Comma-separated paths claimed before dispatch"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        {error && <div className="text-xs text-red">{error}</div>}
      </div>
      <footer className="flex justify-end gap-2 px-4 py-2 border-t border-line-soft">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          variant="accentSoft"
          size="sm"
          onClick={launch}
          disabled={busy}
        >
          {busy ? "Staging…" : "Stage plan"}
        </Button>
      </footer>
    </Dialog>
  );
}
