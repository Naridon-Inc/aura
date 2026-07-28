// Automations — genuine "When this happens → do that" recipes.
//
// A list of automation cards (WHEN → DO → optional THEN), each with an Active
// toggle, Run-now, edit and delete. "+ New automation" opens a compact inline
// form. Starter recipes pre-fill the form's WHEN→DO. A live "Recent runs" feed
// shows both scheduled-automation runs (persisted on each automation's
// last_run) and the live orchestrator lanes the app already tracks.
//
// Chrome: wears the same compact "product view" card language as the Mission
// board + Tasks board — title-hero header with a quiet sub-line, rounded-[6px]
// bg-bg-content cards on the raised-100 shadow, and plain-language section
// rows. No bulky panels, no jargon: a recipe reads "Every weekday at 9am →
// run the crew", a run reads "Done · 2m ago".
//
// Honest labeling: an automation runs *while Aura — or your Aura Runner — is
// on*. We make no cloud-cron claim. The header copy says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Plus } from "lucide-react";
import {
  api,
  type Action,
  type Automation,
  type AutomationInput,
  type LaneOutcome,
  type NoteSummary,
  type Trigger,
} from "../../lib/api";
import { useAgents } from "../../lib/agents";
import { Button } from "../ui/button";
import {
  AutomationForm,
  type AgentChoice,
  type FormSeed,
} from "./AutomationForm";
import { AutomationCard } from "./AutomationCard";
import {
  elapsedBetween,
  localTzOffsetMin,
  relativeTime,
  runVerdict,
} from "./automationsCopy";

// ── Starter recipes ──────────────────────────────────────────────────────
// A starter pre-fills the New-automation form's WHEN→DO — review, tweak, save.
// Never a stub: it becomes a real scheduled automation once saved.

type Starter = {
  id: string;
  category: string;
  title: string;
  desc: string;
  seed: () => FormSeed;
};

function weekdayTrigger(timeHm: string): Trigger {
  return {
    kind: "schedule",
    cadence: "weekdays",
    time_hm: timeHm,
    weekday: 0,
    tz_offset_min: localTzOffsetMin(),
  };
}

function dailyTrigger(timeHm: string): Trigger {
  return {
    kind: "schedule",
    cadence: "daily",
    time_hm: timeHm,
    weekday: 0,
    tz_offset_min: localTzOffsetMin(),
  };
}

function runAgent(prompt: string): Action {
  return { kind: "run_agent", agent: "claude", prompt, model: null };
}

const STARTERS: Starter[] = [
  {
    id: "standup-digest",
    category: "Status reports",
    title: "Standup digest",
    desc: "Every weekday morning, summarize yesterday's work for standup.",
    seed: () => ({
      name: "Standup digest",
      trigger: weekdayTrigger("09:00"),
      action: runAgent(
        "Summarize yesterday's commits, merged PRs, and open work across this repo into a concise standup digest grouped by person. Flag anything blocked.",
      ),
    }),
  },
  {
    id: "pr-recap",
    category: "Status reports",
    title: "Weekly PR recap",
    desc: "Recap recent merged PRs by author and theme; highlight risks.",
    seed: () => ({
      name: "Weekly PR recap",
      trigger: {
        kind: "schedule",
        cadence: "weekly",
        time_hm: "16:00",
        weekday: 4,
        tz_offset_min: localTzOffsetMin(),
      },
      action: runAgent(
        "Recap the PRs merged in the last 7 days, grouped by author and theme. Call out anything risky (migrations, feature flags, broad diffs) and link each PR.",
      ),
    }),
  },
  {
    id: "nightly-review",
    category: "Quality & health",
    title: "Nightly change review",
    desc: "Each night, run the reviewer over the day's changes.",
    seed: () => ({
      name: "Nightly change review",
      trigger: dailyTrigger("23:00"),
      action: { kind: "run_pr_review", base: "main" },
    }),
  },
  {
    id: "bug-scan",
    category: "Quality & health",
    title: "Bug scan",
    desc: "Daily, scan recent commits for likely bugs and propose fixes.",
    seed: () => ({
      name: "Bug scan",
      trigger: dailyTrigger("08:00"),
      action: runAgent(
        "Scan the commits since the last run (or the last 24h) for likely bugs — null/edge cases, race conditions, leaked resources — and propose a concrete fix for each with the file and line.",
      ),
    }),
  },
];

const STARTER_CATEGORIES = ["Status reports", "Quality & health"];

// ── A unified Recent-runs row ─────────────────────────────────────────────

type RecentRow = {
  key: string;
  title: string;
  /** Sort key — newest first. ms since epoch. */
  at: number;
  when: string;
  elapsed: string;
  verdict: { label: string; tone: "ok" | "fail" | "proven" } | null;
  live: boolean;
};

function laneToRow(l: LaneOutcome): RecentRow {
  const end = l.completed_at ?? Math.floor(Date.now() / 1000);
  const secs = Math.max(0, end - l.started_at);
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${(secs % 60).toString().padStart(2, "0")}s`;
  const live = l.status === "running" || l.status === "queued";
  return {
    key: `lane-${l.lane_id}`,
    title: l.spec.label?.trim() || l.spec.objective || l.lane_id,
    at: (l.completed_at ?? l.started_at) * 1000,
    when: live ? "running now" : relativeFromUnix(l.started_at),
    elapsed,
    verdict: live
      ? null
      : l.status === "failed" || l.status === "conflict" || l.status === "cancelled"
        ? { label: capitalize(l.status), tone: "fail" }
        : { label: "Done", tone: "ok" },
    live,
  };
}

function automationToRow(a: Automation): RecentRow | null {
  const r = a.last_run;
  if (!r) return null;
  const at = Date.parse(r.completed_at ?? r.started_at) || Date.now();
  return {
    key: `auto-${a.id}-${r.id}`,
    title: a.name,
    at,
    when: relativeTime(r.completed_at ?? r.started_at),
    elapsed: elapsedBetween(r.started_at, r.completed_at),
    verdict: runVerdict(r),
    live: false,
  };
}

function relativeFromUnix(unixSecs: number): string {
  return relativeTime(new Date(unixSecs * 1000).toISOString());
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Small chrome pieces (defined here, used only on this surface) ─────────

/** A quiet uppercase section label with an optional right-aligned count —
 *  the same calm header grammar the Mission/Tasks columns use, scaled down
 *  to a stacked list section. */
function SectionHead({
  label,
  count,
}: {
  label: string;
  count?: number;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-text-4">
        {label}
      </span>
      {count != null && (
        <span className="text-[10.5px] tabular-nums text-text-5">{count}</span>
      )}
    </div>
  );
}

/** Tone → the dot colour for a Recent-runs row. Only two states earn a hue:
 *  a run happening right now (amber) and a run that failed (red). A finished
 *  run is settled history, so it reads on the neutral ramp like the rest. */
function runDotColor(row: RecentRow): string {
  if (row.live) return "var(--color-amber)";
  if (!row.verdict) return "var(--color-text-4)";
  if (row.verdict.tone === "fail") return "var(--color-red)";
  return "var(--color-text-3)";
}

function runVerdictColor(tone: "ok" | "fail" | "proven"): string {
  if (tone === "fail") return "var(--color-red)";
  return "var(--color-accent-green)";
}

// ── Left rail: glance + recipe library (the same cockpit shape as the Runner) ──

/** The surface's progress at a glance — how many recipes you have and a quiet
 *  tally of active / paused / running-now. The rail's reason to exist; mirrors
 *  the Runner's crew-progress glance. Green = a status (active), amber = an
 *  agent is running one now, muted = paused. */
function AutoGlance({
  recipes,
  active,
  live,
}: {
  recipes: number;
  active: number;
  live: number;
}) {
  const paused = Math.max(0, recipes - active);
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-text-5">
        Automations
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-text-1">
          {recipes}
        </span>
        <span className="text-[12px] text-text-4">
          recipe{recipes === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        <AutoStatRow
          dot="var(--color-accent-green)"
          value={active}
          label="active"
        />
        {paused > 0 ? (
          <AutoStatRow dot="var(--color-text-5)" value={paused} label="paused" />
        ) : null}
        {live > 0 ? (
          <AutoStatRow dot="var(--color-amber)" value={live} label="running now" />
        ) : null}
      </div>
    </div>
  );
}

function AutoStatRow({
  dot,
  value,
  label,
}: {
  dot: string;
  value: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: dot }}
        aria-hidden
      />
      <span className="tabular-nums font-medium text-text-2">{value}</span>
      <span className="text-text-4">{label}</span>
    </div>
  );
}

/** The recipe library, as a compact rail list grouped by category — the
 *  Automations counterpart of the Runner rail's crew list. Clicking a row
 *  pre-fills the New-automation form in the main stage. */
function RecipeRail({ onPick }: { onPick: (s: Starter) => void }) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-text-5">
        Start from a recipe
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {STARTER_CATEGORIES.map((cat) => (
          <div key={cat}>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-text-5/80">
              {cat}
            </div>
            <div className="flex flex-col gap-0.5">
              {STARTERS.filter((s) => s.category === cat).map((s) => (
                <RecipeRow key={s.id} starter={s} onClick={() => onPick(s)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One starter as a compact rail row — a clock glyph, the title, and a quiet
 *  two-line plain-language description. Click pre-fills the form. */
function RecipeRow({
  starter,
  onClick,
}: {
  starter: Starter;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Set up "${starter.title}"`}
      className="group -mx-2 flex w-[calc(100%_+_1rem)] items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-2/60"
    >
      <Clock
        size={13}
        strokeWidth={1.5}
        className="mt-0.5 shrink-0 text-text-4 transition-colors group-hover:text-accent"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-text-2">
          {starter.title}
        </span>
        <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-5">
          {starter.desc}
        </span>
      </span>
    </button>
  );
}

// ── Surface ────────────────────────────────────────────────────────────────

export function AutomationsSurface({ repoRoot }: { repoRoot: string }) {
  const { agents } = useAgents();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [pages, setPages] = useState<NoteSummary[]>([]);
  const [lanes, setLanes] = useState<LaneOutcome[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Form state: null = closed; { seed } = new; { editing } = edit existing.
  const [form, setForm] = useState<
    null | { seed?: FormSeed; editing?: Automation }
  >(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const agentChoices: AgentChoice[] = useMemo(
    () => agents.map((a) => ({ id: a.id, label: a.label, available: a.available })),
    [agents],
  );

  const reload = useCallback(() => {
    api
      .automationsList(repoRoot)
      .then((list) => {
        setAutomations(list);
        setLoadErr(null);
        setLoaded(true);
      })
      .catch((e) => {
        setLoadErr(String(e));
        setLoaded(true);
      });
  }, [repoRoot]);

  // Initial load + reload on the scheduler's "automations:changed" event.
  useEffect(() => {
    reload();
    api
      .notesList({ repoRoot })
      .then(setPages)
      .catch(() => setPages([]));
  }, [repoRoot, reload]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("automations:changed", (e) => {
        if (alive && (!e.payload || e.payload === repoRoot)) reload();
      }).then((un) => {
        if (alive) unlisten = un;
        else un();
      });
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [repoRoot, reload]);

  // Poll live orchestration lanes for the Recent-runs feed (3s, small list).
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .orchestratorListActive()
        .then((l) => alive && setLanes(l))
        .catch(() => alive && setLanes([]));
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const recentRows = useMemo(() => {
    const rows: RecentRow[] = [];
    for (const l of lanes) rows.push(laneToRow(l));
    for (const a of automations) {
      const r = automationToRow(a);
      if (r) rows.push(r);
    }
    rows.sort((x, y) => {
      if (x.live !== y.live) return x.live ? -1 : 1;
      return y.at - x.at;
    });
    return rows.slice(0, 12);
  }, [lanes, automations]);

  const save = useCallback(
    (input: AutomationInput) => {
      const editing = form?.editing;
      const p = editing
        ? api.automationUpdate(repoRoot, editing.id, input)
        : api.automationCreate(repoRoot, input);
      p.then(() => {
        setForm(null);
        reload();
      }).catch((e) => setLoadErr(String(e)));
    },
    [form, repoRoot, reload],
  );

  const toggle = useCallback(
    (id: string, enabled: boolean) => {
      // Optimistic flip so the toggle feels instant.
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, enabled } : a)),
      );
      api.automationSetEnabled(repoRoot, id, enabled).then(reload).catch(reload);
    },
    [repoRoot, reload],
  );

  const remove = useCallback(
    (id: string) => {
      api.automationDelete(repoRoot, id).then(reload).catch(reload);
    },
    [repoRoot, reload],
  );

  const runNow = useCallback(
    (id: string) => {
      setRunningId(id);
      api
        .automationRunNow(repoRoot, id)
        .then(() => reload())
        .catch((e) => setLoadErr(String(e)))
        .finally(() => setRunningId(null));
    },
    [repoRoot, reload],
  );

  const startNew = useCallback(() => setForm({}), []);
  const startStarter = useCallback((s: Starter) => setForm({ seed: s.seed() }), []);

  const activeCount = automations.filter((a) => a.enabled).length;
  const liveCount = lanes.filter(
    (l) => l.status === "running" || l.status === "queued",
  ).length;

  return (
    <div className="flex h-full w-full bg-bg-content text-text-1">
      {/* Left rail — scope & glance + the recipe library, the same cockpit
          shape as the Runner: a quiet count/active tally, the one primary
          "New automation" affordance, then the starter recipes as a launcher
          list. The rail's "Automations" label carries context (the tab /
          pane name already names the surface — no masthead title). */}
      <aside className="flex w-[244px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line-soft px-4 py-5">
        <AutoGlance
          recipes={automations.length}
          active={activeCount}
          live={liveCount}
        />
        <Button
          variant="accentSoft"
          size="sm"
          onClick={startNew}
          className="w-full justify-center gap-1"
          title="Set up a new automation"
        >
          <Plus className="h-3 w-3" strokeWidth={2} aria-hidden />
          New automation
        </Button>
        <RecipeRail onPick={startStarter} />
        <p className="mt-auto pt-3 text-[11px] leading-relaxed text-text-5">
          Automations run while Aura — or your Aura Runner — is on. No cloud
          required.
        </p>
      </aside>

      {/* Main stage — the form (when open), your automations, and recent runs */}
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {/* Inline form (new or edit) */}
        {form && (
          <section className="mb-5">
            <AutomationForm
              agents={agentChoices}
              pages={pages}
              seed={form.seed}
              existing={form.editing}
              onCancel={() => setForm(null)}
              onSave={save}
            />
          </section>
        )}

        {/* Your automations */}
        <section className="mb-7">
          {loadErr && (
            <p className="mb-2 rounded-[6px] border border-line-soft bg-bg-2 px-3 py-2 text-[11.5px] leading-snug text-red">
              Couldn't load automations: {loadErr}
            </p>
          )}

          <SectionHead
            label="Your automations"
            count={automations.length || undefined}
          />

          {loaded && automations.length === 0 && !form ? (
            <div className="rounded-[6px] border border-dashed border-line-soft bg-bg-content px-3.5 py-5 text-[11.5px] leading-relaxed text-text-4">
              No automations yet. Hit{" "}
              <strong className="text-text-2">New automation</strong> for
              something like "Every weekday at 9am → run the crew" — or pick a
              recipe on the left.
            </div>
          ) : (
            <div className="space-y-2">
              {automations.map((a) => (
                <AutomationCard
                  key={a.id}
                  automation={a}
                  running={runningId === a.id}
                  onToggle={(enabled) => toggle(a.id, enabled)}
                  onRunNow={() => runNow(a.id)}
                  onEdit={() => setForm({ editing: a })}
                  onDelete={() => remove(a.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent runs */}
        <section>
          <SectionHead label="Recent runs" />
          {recentRows.length === 0 ? (
            <div className="rounded-[6px] border border-line-soft bg-bg-content px-3.5 py-4 text-[11.5px] leading-relaxed text-text-4">
              No runs yet. Turn an automation on or use "Run now" — finished runs
              show here with how long they took.
            </div>
          ) : (
            <div
              className="overflow-hidden rounded-[6px] border border-line-soft bg-bg-content"
              style={{ boxShadow: "var(--shadow-raised-100)" }}
            >
              {recentRows.map((r, i) => (
                <div
                  key={r.key}
                  className={`flex items-center gap-2.5 px-3 py-2 ${
                    i > 0 ? "border-t-[0.5px] border-line-soft" : ""
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      r.live ? "animate-pulse" : ""
                    }`}
                    style={{ background: runDotColor(r) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-1">
                    {r.title}
                  </span>
                  <span className="flex-shrink-0 text-[10.5px] tabular-nums text-text-4">
                    {r.when}
                    {r.elapsed ? ` · ${r.elapsed}` : ""}
                  </span>
                  {r.verdict && (
                    <span
                      className="flex-shrink-0 text-[10.5px] font-medium"
                      style={{ color: runVerdictColor(r.verdict.tone) }}
                    >
                      {r.verdict.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
