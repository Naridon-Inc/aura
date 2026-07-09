// Crew · Runner — the control-room cockpit for the autonomous work loop. A
// full-bleed two-column surface (no centered column, no wasted margins), so it
// fills the screen the same way the Board and Plan tabs do:
//
//   LEFT RAIL (scope & glance) — the crew's progress at a glance (done/total bar
//   + working/ready/failed tally) and the crew picker (pick one to scope the
//   whole surface to it; spawn a second to run alongside). A quiet "/loop" hint
//   reminds you the same runs drive from chat.
//
//   MAIN STAGE (live & control), top to bottom:
//     • Running now — every task an agent is on right this second (from
//       `ready_view.working`): agent logo, title, a live elapsed timer, and a
//       click that opens its detail in Plan. Idle shows one calm line.
//     • Goals — each goal as one control lane: a slim done/total progress bar
//       tinted by state, the plain-language status, and ONE primary control
//       (Start ready work · Pause once an agent's on it · Resume when parked).
//       Past runs roll up underneath. No wall of identical buttons.
//     • Past runs — the crew's whole-queue track record, newest first.
//
// Arctic-blue (the theme accent) marks the one primary affordance per lane;
// amber = an agent is working; green/red are status-only. No DAG / lease / node
// jargon — plain words. No mock state: `goals` / `crews` / `working` come
// straight from the unified `ready_view`; `runs` from `.aura/crew/runs.jsonl`.

import { useState } from "react";
import {
  ChevronRight,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  Users,
} from "lucide-react";

import type {
  CrewRow,
  GoalSummary,
  LoopTask,
  RunRecord,
} from "../../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { StatusChip } from "../../ui/statusChip";
import {
  goalAffordances,
  goalsForCrew,
  humanizeGoal,
  runOutcomeLabel,
  runScopeLabel,
  runsForGoal,
} from "./crewControl";
import {
  AgentBit,
  CommitChip,
  CREW_ACCENT,
  PriorityChip,
  relativeTime,
} from "./crewShared";

export type ControlScope = { goal?: string; crew?: string };

/** The crew's lifecycle totals, summed across the goals in scope — what the
 *  glance rail draws. Goal-derived (loose, goal-less tasks aren't counted),
 *  which is the honest read for a goal-centric control surface. */
type GoalAgg = {
  total: number;
  done: number;
  ready: number;
  working: number;
  failed: number;
  paused: number;
};

function aggregateGoals(goals: GoalSummary[]): GoalAgg {
  return goals.reduce<GoalAgg>(
    (a, g) => ({
      total: a.total + g.total,
      done: a.done + g.done,
      ready: a.ready + g.ready,
      working: a.working + g.working,
      failed: a.failed + g.failed,
      paused: a.paused + g.paused,
    }),
    { total: 0, done: 0, ready: 0, working: 0, failed: 0, paused: 0 },
  );
}

export function CrewControlTab({
  crews,
  activeCrew,
  onSelectCrew,
  goals,
  runs,
  working,
  now,
  acting,
  onSpawnCrew,
  onRunGoal,
  onPauseGoal,
  onResumeGoal,
  onOpenTask,
}: {
  crews: CrewRow[];
  activeCrew: string | null;
  onSelectCrew: (id: string | null) => void;
  goals: GoalSummary[];
  runs: RunRecord[];
  /** The live working set from `ready_view` — the tasks an agent is on now. */
  working: LoopTask[];
  /** Ticking clock from the surface, for live "how long it's been going". */
  now: number;
  /** The goal slug currently being acted on (Run/Pause/Resume), so only that
   *  card spins and the rest stay enabled. `""` marks a crew-wide action. */
  acting: string | null;
  onSpawnCrew: (title: string) => Promise<void>;
  onRunGoal: (goal: GoalSummary) => void;
  onPauseGoal: (goal: GoalSummary) => void;
  onResumeGoal: (goal: GoalSummary) => void;
  /** Open a task's detail (in the Plan tab) — wired from a Running-now row. */
  onOpenTask: (taskId: string) => void;
}) {
  const scopedGoals = goalsForCrew(goals, crews, activeCrew);
  // The working tasks that belong to the focused crew — scoped by the same goal
  // membership goalsForCrew uses, so the band tracks the crew filter. "All
  // crews" (null) shows every agent at work.
  const scopedIds = new Set(scopedGoals.flatMap((g) => g.task_ids));
  const scopedWorking =
    activeCrew === null
      ? working
      : working.filter((t) => scopedIds.has(t.id));
  // Runs that belong to no specific goal — the "whole crew" history — shown
  // once at the bottom so the crew's track record is visible, not just goals'.
  const wholeQueueRuns = runs.filter((r) => !r.goal);
  const agg = aggregateGoals(scopedGoals);

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail — scope & glance */}
      <aside className="flex w-[244px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line-soft px-4 py-5">
        <GlanceSummary agg={agg} working={scopedWorking.length} />
        <CrewRail
          crews={crews}
          activeCrew={activeCrew}
          onSelectCrew={onSelectCrew}
          onSpawnCrew={onSpawnCrew}
        />
        <p className="mt-auto pt-3 text-[11px] leading-relaxed text-text-5">
          The same runs drive from chat with{" "}
          <span className="font-mono text-text-4">/loop</span>.
        </p>
      </aside>

      {/* Main stage — live & control */}
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <RunningNow tasks={scopedWorking} now={now} onOpenTask={onOpenTask} />

        <div className="mt-6">
          <SectionHeading
            title="Goals"
            hint="Start and pause each goal on its own — every run is logged."
          />
          {scopedGoals.length === 0 ? (
            <p className="mt-3 rounded-[6px] border border-dashed border-line-soft bg-bg-content px-4 py-6 text-center text-[12px] leading-relaxed text-text-4">
              No goals here yet. Plan one from{" "}
              <strong className="text-text-2">Add to queue</strong> — it lands as
              a connected set of tasks you can start and pause as one, and the
              crew puts an agent on each.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-1.5">
              {scopedGoals.map((g) => (
                <GoalLane
                  key={g.goal}
                  goal={g}
                  runs={runsForGoal(runs, g.goal)}
                  acting={acting === g.goal}
                  anyActing={acting !== null}
                  onRun={() => onRunGoal(g)}
                  onPause={() => onPauseGoal(g)}
                  onResume={() => onResumeGoal(g)}
                />
              ))}
            </div>
          )}
        </div>

        {wholeQueueRuns.length > 0 ? (
          <div className="mt-7">
            <SectionHeading
              title="Past runs"
              hint="Every time the crew worked the whole queue, newest first."
            />
            <div className="mt-3 overflow-hidden rounded-[6px] border border-line-soft bg-bg-content">
              {wholeQueueRuns.slice(0, 12).map((r, i) => (
                <RunRow key={r.id} run={r} first={i === 0} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A section label in the redesigned grammar — a plain title (the hero) with a
 *  quiet one-line hint beside it. No icon chrome; the title carries it. */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-text-1">
        {title}
      </h3>
      <span className="text-[11.5px] text-text-4">{hint}</span>
    </div>
  );
}

// ─── Left rail: glance summary ──────────────────────────────────────────

/** The crew's progress at a glance — a big done/total with a bar, then a quiet
 *  tally of what's working / ready / couldn't finish. The rail's reason to
 *  exist even on a single-crew project. */
function GlanceSummary({ agg, working }: { agg: GoalAgg; working: number }) {
  const pct = agg.total > 0 ? Math.round((agg.done / agg.total) * 100) : 0;
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-text-5">
        Crew progress
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-text-1">
          {agg.done}
        </span>
        <span className="text-[12px] text-text-4">/ {agg.total} done</span>
      </div>
      <span className="mt-2.5 block h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: CREW_ACCENT.done }}
        />
      </span>
      <div className="mt-3 flex flex-col gap-1.5">
        <StatRow dot={CREW_ACCENT.working} value={working} label="working now" />
        <StatRow
          dot="var(--color-accent)"
          value={agg.ready}
          label="ready to start"
        />
        {agg.failed > 0 ? (
          <StatRow
            dot={CREW_ACCENT.failed}
            value={agg.failed}
            label="couldn't finish"
          />
        ) : null}
        {agg.paused > 0 ? (
          <StatRow
            dot="var(--color-text-5)"
            value={agg.paused}
            label="paused"
          />
        ) : null}
      </div>
    </div>
  );
}

function StatRow({
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

// ─── Left rail: crews ───────────────────────────────────────────────────

/** The crew picker, as a vertical rail list. "All crews" only earns a row once
 *  there's more than one; a single-crew project just shows its one crew plus
 *  the quiet "+ New crew" affordance. */
function CrewRail({
  crews,
  activeCrew,
  onSelectCrew,
  onSpawnCrew,
}: {
  crews: CrewRow[];
  activeCrew: string | null;
  onSelectCrew: (id: string | null) => void;
  onSpawnCrew: (title: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [spawning, setSpawning] = useState(false);

  const submit = async () => {
    const title = name.trim();
    if (!title || spawning) return;
    setSpawning(true);
    try {
      await onSpawnCrew(title);
      setName("");
      setAdding(false);
    } finally {
      setSpawning(false);
    }
  };

  const showAll = crews.length > 1;

  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-text-5">
        Crews
      </div>
      <div className="mt-2 flex flex-col gap-0.5">
        {showAll ? (
          <CrewRowItem
            label="All crews"
            active={activeCrew === null}
            onClick={() => onSelectCrew(null)}
          />
        ) : null}
        {crews.map((c) => (
          <CrewRowItem
            key={c.meta.id}
            label={c.meta.title}
            count={c.summary.total}
            working={c.summary.working}
            active={activeCrew === c.meta.id}
            onClick={() => onSelectCrew(c.meta.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
            placeholder="Crew name"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            variant="default"
            size="xs"
            onClick={() => void submit()}
            disabled={!name.trim() || spawning}
          >
            {spawning ? <Loader2 size={12} className="animate-spin" /> : "Add"}
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setAdding(true)}
          className="mt-1.5 w-full justify-start gap-1 text-text-4"
          title="Spawn a second crew to run alongside this one"
        >
          <Plus size={12} />
          New crew
        </Button>
      )}
    </div>
  );
}

/** One crew as a rail row. Active wears the theme accent with an inset bar; an
 *  amber spinner means an agent is on something in it. */
function CrewRowItem({
  label,
  count,
  working,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  working?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "-mx-2 flex w-[calc(100%_+_1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
        active
          ? "bg-bg-2 font-medium text-text-1"
          : "text-text-2 hover:bg-bg-2/60",
      ].join(" ")}
    >
      <Users
        size={13}
        className={active ? "text-text-3" : "text-text-4"}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {working && working > 0 ? (
        <Loader2
          size={11}
          className="shrink-0 animate-spin"
          style={{ color: CREW_ACCENT.working }}
        />
      ) : null}
      {typeof count === "number" ? (
        <span
          className={[
            "shrink-0 text-[11px] tabular-nums",
            active ? "opacity-80" : "text-text-4",
          ].join(" ")}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

// ─── Running now (the live pulse) ───────────────────────────────────────

/** The main stage's head — every task an agent is on right now. Always
 *  rendered: a live list when busy, one calm line when idle. Amber throughout
 *  (an agent is working = amber). Each row opens that task's detail in Plan. */
function RunningNow({
  tasks,
  now,
  onOpenTask,
}: {
  tasks: LoopTask[];
  now: number;
  onOpenTask: (taskId: string) => void;
}) {
  const n = tasks.length;
  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: n > 0 ? CREW_ACCENT.working : "var(--color-text-5)",
          }}
          aria-hidden
        />
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-text-1">
          Running now
        </h3>
        <span className="text-[11.5px] text-text-4">
          {n === 0
            ? "Nothing running — Start a goal to put agents to work"
            : `${n} agent${n === 1 ? "" : "s"} working`}
        </span>
      </div>
      {n > 0 ? (
        <div className="mt-2.5 flex flex-col gap-0.5">
          {tasks.map((t) => (
            <RunningRow
              key={t.id}
              task={t}
              now={now}
              onOpen={() => onOpenTask(t.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One in-flight task — agent logo · title · how long it's been going · open. */
function RunningRow({
  task,
  now,
  onOpen,
}: {
  task: LoopTask;
  now: number;
  onOpen: () => void;
}) {
  const elapsed = elapsedShort(task.updated_at, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-content/70"
      title={`${task.title} — open its detail`}
    >
      <AgentBit agentKind={task.agent_kind} size={18} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-1">
        {task.title}
      </span>
      <PriorityChip priority={task.priority} />
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums"
        style={{ color: CREW_ACCENT.working }}
      >
        <Loader2 size={11} className="animate-spin" />
        {elapsed}
      </span>
      <ChevronRight
        size={13}
        className="shrink-0 text-text-5 opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </button>
  );
}

// ─── Goal control lane (W-B) ────────────────────────────────────────────

/** One goal as a control lane — a compact row on bg-bg-content with a raised
 *  shadow: a state dot, the title, a slim progress bar (done / total) tinted by
 *  the goal's state, the plain-language status, and ONE primary control on the
 *  right (Start ready work · Pause once an agent's on it · Resume when parked).
 *  Past runs roll up underneath. */
function GoalLane({
  goal,
  runs,
  acting,
  anyActing,
  onRun,
  onPause,
  onResume,
}: {
  goal: GoalSummary;
  runs: RunRecord[];
  acting: boolean;
  anyActing: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [open, setOpen] = useState(false);
  const a = goalAffordances(goal);
  const disabled = anyActing && !acting;
  const accent = goalAccent(goal);
  const running = goal.working > 0;
  const pct = goal.total > 0 ? Math.round((goal.done / goal.total) * 100) : 0;

  return (
    <div
      className="rounded-[6px] border border-line-soft bg-bg-content transition-all"
      style={{ boxShadow: "var(--shadow-raised-100)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-200)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-100)";
      }}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: accent }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium leading-snug text-text-1">
            {humanizeGoal(goal.goal)}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <ProgressBar
              pct={pct}
              done={goal.done}
              total={goal.total}
              accent={accent}
            />
            <GoalLead goal={goal} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {a.canResume ? (
            <Button
              variant="subtle"
              size="xs"
              onClick={onResume}
              disabled={disabled}
              className="gap-1"
              title="Un-pause this goal's tasks"
            >
              {acting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              Resume
            </Button>
          ) : null}
          {running ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={onPause}
              disabled={disabled}
              className="gap-1 text-text-4"
              title="Park this goal's tasks out of the queue"
            >
              {acting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Pause size={12} />
              )}
              Pause
            </Button>
          ) : a.canRun ? (
            <Button
              variant="default"
              size="xs"
              onClick={onRun}
              disabled={disabled}
              className="gap-1"
              title="Put an agent on this goal's ready tasks"
            >
              {acting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              Start
            </Button>
          ) : null}
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="border-t border-line-soft">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] text-text-4 hover:text-text-2"
          >
            <ChevronRight
              size={12}
              className={
                open ? "rotate-90 transition-transform" : "transition-transform"
              }
            />
            <History size={11} className="text-text-5" />
            {runs.length} past run{runs.length === 1 ? "" : "s"}
            <span className="text-text-5">
              · latest {relativeTime(runs[0]!.started_at)}
            </span>
          </button>
          {open ? (
            <div className="border-t border-line-soft">
              {runs.slice(0, 8).map((r, i) => (
                <RunRow key={r.id} run={r} first={i === 0} compact />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The slim done/total bar fronting a goal lane — fill tinted by the goal's
 *  state (amber while working, green when done, accent when there's ready work)
 *  with a quiet tabular "done/total" beside it. */
function ProgressBar({
  pct,
  done,
  total,
  accent,
}: {
  pct: number;
  done: number;
  total: number;
  accent: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="block h-1 w-24 shrink-0 overflow-hidden rounded-full bg-bg-2">
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: accent }}
        />
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-text-4">
        {done}/{total}
      </span>
    </span>
  );
}

/** The one quiet plain-language status read beside a goal's progress bar — what
 *  the goal needs from you now. Amber "An agent is on it" while working, green
 *  "Done" when finished, accent "N ready to start" when there's work waiting,
 *  then muted Paused/Queued. No redundant done/total (the bar shows that). */
function GoalLead({ goal }: { goal: GoalSummary }) {
  const a = goalAffordances(goal);
  if (goal.working > 0) {
    return (
      <span
        className="text-[11px] font-medium"
        style={{ color: CREW_ACCENT.working }}
      >
        An agent is on it
        {goal.working > 1 ? ` · ${goal.working} in flight` : ""}
      </span>
    );
  }
  if (a.finished) {
    return (
      <span className="text-[11px] font-medium" style={{ color: CREW_ACCENT.done }}>
        Done
        {goal.failed > 0 ? ` · ${goal.failed} couldn't finish` : ""}
      </span>
    );
  }
  if (goal.failed > 0) {
    return (
      <span className="text-[11px] font-medium" style={{ color: CREW_ACCENT.failed }}>
        {goal.failed} couldn't finish — open Work to retry
      </span>
    );
  }
  if (goal.ready > 0) {
    return (
      <span
        className="text-[11px] font-medium"
        style={{ color: "var(--color-accent)" }}
      >
        {goal.ready} ready to start
      </span>
    );
  }
  if (goal.paused > 0) {
    return (
      <span className="text-[11px] text-text-4">
        Paused — Resume to put it back in the queue
      </span>
    );
  }
  return <span className="text-[11px] text-text-4">Queued</span>;
}

/** The state colour for a goal's title dot + progress fill — amber while an
 *  agent works, red on a failure, green when finished, accent when there's
 *  ready work, muted otherwise. Green/red are status-only; accent marks
 *  runnable work. */
function goalAccent(g: GoalSummary): string {
  if (g.working > 0) return CREW_ACCENT.working;
  if (g.failed > 0) return CREW_ACCENT.failed;
  if (g.total > 0 && g.done >= g.total) return CREW_ACCENT.done;
  if (g.ready > 0) return "var(--color-accent)";
  return "var(--color-text-5)";
}

// ─── One run-history row ────────────────────────────────────────────────

/** One past run as a quiet row — the muted footer-meta grammar of the Mission
 *  cards: scope (the hero), a plain outcome read, the commit it landed, and
 *  "2m ago", all in tabular muted type. */
function RunRow({
  run,
  first,
  compact,
}: {
  run: RunRecord;
  first: boolean;
  compact?: boolean;
}) {
  const commit = run.nodes.find((n) => n.commit)?.commit ?? null;
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 px-3 py-2 text-[11px]",
        first ? "" : "border-t border-line-soft",
        compact ? "bg-bg-1/40" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-text-2">
          {runScopeLabel(run)}
        </span>
        <RunOutcomeChip run={run} />
        {commit ? <CommitChip sha={commit} /> : null}
      </div>
      <span className="shrink-0 whitespace-nowrap tabular-nums text-text-5">
        {relativeTime(run.started_at)}
      </span>
    </div>
  );
}

/** The run's outcome as a quiet, plain-language read — green when it all
 *  landed, red when something failed, muted when it did no work. Status-only
 *  colour; never an affordance. */
function RunOutcomeChip({ run }: { run: RunRecord }) {
  const label = runOutcomeLabel(run);
  const tone = run.failed > 0 ? "red" : run.completed > 0 ? "green" : "neutral";
  return (
    <StatusChip tone={tone} dense>
      {label}
    </StatusChip>
  );
}

/** Plain-language elapsed since a unix stamp — "4m" / "2h" / "just now", no
 *  "ago" (this reads as a live timer). Tolerant of seconds- or millis-epoch
 *  like `relativeTime`. */
function elapsedShort(unix: number | null | undefined, now: number): string {
  if (!unix || unix <= 0) return "just now";
  const ms = unix < 1e12 ? unix * 1000 : unix;
  const diff = now - ms;
  if (diff < 45000) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
