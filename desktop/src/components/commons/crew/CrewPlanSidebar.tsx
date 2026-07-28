// Crew · Plan — the ONE sidebar. Goals are the grouping; their tasks nest under
// them. Each goal is a collapsible lane: a state dot, the plain-language title,
// a done/total bar, the one primary control (Start · Pause · Resume), and — when
// open — its own tasks as rows plus its past runs. Tasks that belong to no goal
// (loose, board-synced work) collect under "Other tasks" at the foot.
//
// This replaces the old Tasks | Goals split: goals and their tasks are no longer
// two separate views you toggle between — a goal simply IS a group of tasks, so
// the tree shows both at once, read top-to-bottom. The canvas beside it draws
// the very same graph — including cross-goal dependency edges (a task in one goal
// can wait on a task in another; the engine keeps and verifies that link). Same
// unified `ready_view` the runner and chat's `/loop` read — no new data, no mock.

import { useMemo, useState } from "react";
import {
  ChevronRight,
  History,
  ListTree,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Users,
  X,
} from "lucide-react";

import type {
  CrewRow,
  GoalSummary,
  LoopTask,
  ReadyViewDto,
  RunRecord,
} from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Segment } from "../../ui/segment";
import { StatusChip } from "../../ui/statusChip";
import { StateGlyph } from "../../tasks/StatePill";
import {
  goalAffordances,
  goalsForCrew,
  humanizeGoal,
  runOutcomeLabel,
  runScopeLabel,
  runsForGoal,
} from "./crewControl";
import { crewPickOrder, priorityKey } from "./crewQueue";
import {
  AgentBit,
  CommitChip,
  CREW_ACCENT,
  PriorityChip,
  relativeTime,
  StatusGlyph,
  WorkingLine,
} from "./crewShared";

// ─── Task indexing ──────────────────────────────────────────────────────────

type TaskStatus =
  | "working"
  | "ready"
  | "blocked"
  | "paused"
  | "failed"
  | "done"
  | "other";

type IndexedTask = { task: LoopTask; status: TaskStatus; unmet?: number };

/** Where each task sits in the lifecycle, keyed by id — the join that lets a
 *  goal's `task_ids` resolve to real, status-carrying tasks (and lets us find
 *  the loose tasks that belong to no goal). One pass over the partitioned view.
 *  A node whose own status is `failed` reads as failed wherever the view filed
 *  it, so the plan can flag it (and offer a retry) inline. */
function indexTasks(view: ReadyViewDto): Map<string, IndexedTask> {
  const m = new Map<string, IndexedTask>();
  for (const t of view.working) m.set(t.id, { task: t, status: "working" });
  for (const t of view.ready) m.set(t.id, { task: t, status: "ready" });
  for (const b of view.blocked)
    m.set(b.task.id, { task: b.task, status: "blocked", unmet: b.unmet.length });
  for (const t of view.paused) m.set(t.id, { task: t, status: "paused" });
  for (const t of view.done) m.set(t.id, { task: t, status: "done" });
  for (const t of view.other) if (!m.has(t.id)) m.set(t.id, { task: t, status: "other" });
  // A failed node keeps its failed read no matter which lane the backend filed
  // it under (usually `done` or `other`), so the run's failure never hides.
  for (const it of m.values()) if (it.task.status === "failed") it.status = "failed";
  return m;
}

// Sort order inside a group: live work first, then anything that failed (needs
// you), then what runs next, then the waiting/parked, then the finished tail.
// Ready ties break on pick order.
const STATUS_RANK: Record<TaskStatus, number> = {
  working: 0,
  failed: 1,
  ready: 2,
  blocked: 3,
  paused: 4,
  other: 5,
  done: 6,
};

// How many task rows to show inside one goal before the rest collapse behind a
// "show all" — enough to plan around, few enough to keep the tree scannable.
const GROUP_ROW_CAP = 12;

export function CrewPlanSidebar({
  view,
  selectedId,
  onSelect,
  onSync,
  syncing,
  crews,
  activeCrew,
  onSelectCrew,
  runs,
  acting,
  onSpawnCrew,
  onRunGoal,
  onPauseGoal,
  onResumeGoal,
  onRetry,
}: {
  view: ReadyViewDto;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSync?: () => void;
  syncing?: boolean;
  crews: CrewRow[];
  activeCrew: string | null;
  onSelectCrew: (id: string | null) => void;
  runs: RunRecord[];
  /** The goal slug currently being acted on (Run/Pause/Resume), so only that
   *  lane spins and the rest stay enabled. */
  acting: string | null;
  onSpawnCrew: (title: string) => Promise<void>;
  onRunGoal: (goal: GoalSummary) => void;
  onPauseGoal: (goal: GoalSummary) => void;
  onResumeGoal: (goal: GoalSummary) => void;
  /** Re-arm and run a single failed task — powers the inline "Retry" on a
   *  failed row. Same primitive the detail drawer's Retry uses. */
  onRetry?: (id: string) => void;
}) {
  // Two views of the same plan, switched by the tab strip: "plan" is the
  // goal→task tree (this crew's work); "crews" is the workstream switcher.
  const [tab, setTab] = useState<"plan" | "crews">("plan");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const index = useMemo(() => indexTasks(view), [view]);
  // Pick order over the whole ready set → a per-id rank so a goal's ready tasks
  // list in the exact order the crew will take them.
  const pickRank = useMemo(() => {
    const r = new Map<string, number>();
    crewPickOrder(view.ready).forEach((t, i) => r.set(t.id, i));
    return r;
  }, [view.ready]);

  const scopedGoals = goalsForCrew(view.goals, crews, activeCrew);

  // Every id that lives under SOME goal (across all goals, not just the scoped
  // set) — so "Other tasks" is honestly the loose work that no goal claims,
  // regardless of which crew is in focus.
  const claimed = useMemo(() => {
    const s = new Set<string>();
    for (const g of view.goals) for (const id of g.task_ids) s.add(id);
    return s;
  }, [view.goals]);

  const resolveTasks = (ids: string[]): IndexedTask[] =>
    ids
      .map((id) => index.get(id))
      .filter((x): x is IndexedTask => x != null)
      .sort((a, b) => {
        const d = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (d !== 0) return d;
        if (a.status === "ready")
          return (pickRank.get(a.task.id) ?? 0) - (pickRank.get(b.task.id) ?? 0);
        return 0;
      });

  const ungrouped = useMemo(
    () =>
      [...index.values()]
        .filter((it) => !claimed.has(it.task.id))
        .sort((a, b) => {
          const d = STATUS_RANK[a.status] - STATUS_RANK[b.status];
          if (d !== 0) return d;
          if (a.status === "ready")
            return (pickRank.get(a.task.id) ?? 0) - (pickRank.get(b.task.id) ?? 0);
          return 0;
        }),
    [index, claimed, pickRank],
  );

  const wholeQueueRuns = runs.filter((r) => !r.goal);

  // Search — match on task title or the goal's plain-language name. A goal
  // whose name matches keeps all its tasks; otherwise it keeps only the tasks
  // that match (and drops out entirely if none do).
  const matches = (it: IndexedTask) => !q || it.task.title.toLowerCase().includes(q);
  const visibleGoals = scopedGoals
    .map((g) => {
      const all = resolveTasks(g.task_ids);
      const titleHit = !q || humanizeGoal(g.goal).toLowerCase().includes(q);
      return { goal: g, tasks: titleHit ? all : all.filter(matches), titleHit };
    })
    .filter((v) => !q || v.titleHit || v.tasks.length > 0);
  const visibleUngrouped = q ? ungrouped.filter(matches) : ungrouped;

  const empty = scopedGoals.length === 0 && ungrouped.length === 0;
  const noHits = !!q && visibleGoals.length === 0 && visibleUngrouped.length === 0;

  // The crew currently scoping the plan (null = all crews), for the scope chip.
  const activeCrewRow = activeCrew
    ? crews.find((c) => c.meta.id === activeCrew) ?? null
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3.5 pb-2.5 pt-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-4">
          The plan
        </div>
        {/* Two views of the same plan: the goal→task tree, and the crews that
            run it. Full-width segment so the split reads as one control. */}
        <Segment
          className="mt-2"
          stretch
          size="sm"
          ariaLabel="Plan view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "plan", label: "Goals & Tasks", icon: <ListTree /> },
            {
              value: "crews",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Crews
                  {crews.length > 1 ? (
                    <span className="tabular-nums opacity-70">{crews.length}</span>
                  ) : null}
                </span>
              ),
              icon: <Users />,
            },
          ]}
        />
        {/* Filter goals + tasks by name — plan view only, quiet until you type. */}
        {tab === "plan" ? (
          <div className="relative mt-2.5">
            <Search
              size={12.5}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-5"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the plan"
              className="h-7 pl-7 pr-7 text-[12px]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-text-5 hover:bg-bg-2 hover:text-text-2"
                title="Clear"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {tab === "plan" ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-6">
          {/* When a single crew is in focus, say so up top with a one-click
              way back to all crews — the switcher itself lives in the tab. */}
          {activeCrewRow && !q ? (
            <div className="flex items-center gap-2 rounded-md border border-line-soft bg-bg-2 px-2.5 py-1.5 text-[11px]">
              <Users size={12} className="shrink-0 text-text-4" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-text-2">
                <span className="font-medium text-text-1">{activeCrewRow.meta.title}</span>{" "}
                only
              </span>
              <button
                type="button"
                onClick={() => onSelectCrew(null)}
                className="shrink-0 rounded px-1.5 py-0.5 text-text-4 hover:bg-bg-3 hover:text-text-2"
                title="Show every crew's work"
              >
                All crews
              </button>
            </div>
          ) : null}

          {!q ? <StatusOverview view={view} /> : null}

          {empty ? (
            <p className="rounded-[6px] border border-dashed border-line-soft bg-bg-content px-3 py-5 text-center text-[11.5px] leading-relaxed text-text-4">
              No work yet. Plan a goal from{" "}
              <strong className="text-text-2">Add to queue</strong> — it lands as a
              connected set of tasks you start and pause as one, and the crew puts
              an agent on each. Goals you plan from Aura chat show up here too.
            </p>
          ) : null}

          {noHits ? (
            <p className="px-1 py-4 text-center text-[11.5px] text-text-5">
              Nothing matches “{query}”.
            </p>
          ) : null}

          {/* Goals, each with its tasks nested under it. */}
          {visibleGoals.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {visibleGoals.map((v) => (
                <GoalGroup
                  key={v.goal.goal}
                  goal={v.goal}
                  tasks={v.tasks}
                  runs={runsForGoal(runs, v.goal.goal)}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onRetry={onRetry}
                  forceOpen={!!q}
                  acting={acting === v.goal.goal}
                  anyActing={acting !== null}
                  onRun={() => onRunGoal(v.goal)}
                  onPause={() => onPauseGoal(v.goal)}
                  onResume={() => onResumeGoal(v.goal)}
                />
              ))}
            </div>
          ) : null}

          {/* Loose tasks — work the board handed us that no goal claims. */}
          {visibleUngrouped.length > 0 ? (
            <OtherTasks
              tasks={visibleUngrouped}
              selectedId={selectedId}
              onSelect={onSelect}
              onRetry={onRetry}
              forceOpen={!!q}
            />
          ) : null}

          {/* The crew's whole-queue track record, collapsed. */}
          {wholeQueueRuns.length > 0 && !q ? (
            <PastRuns runs={wholeQueueRuns} />
          ) : null}
        </div>
      ) : (
        <CrewsTab
          view={view}
          crews={crews}
          activeCrew={activeCrew}
          onPick={(id) => {
            onSelectCrew(id);
            setTab("plan");
          }}
          onSpawnCrew={onSpawnCrew}
        />
      )}

      {tab === "plan" && onSync ? (
        <div className="shrink-0 border-t border-line-soft px-3 py-2.5">
          <Button
            variant="subtle"
            size="sm"
            onClick={onSync}
            disabled={!!syncing}
            className="w-full gap-1.5"
            title="Project your task board into the work queue"
          >
            {syncing ? (
              <AsciiSpinner className="text-[12px]" />
            ) : (
              <RefreshCw size={13} />
            )}
            Sync from board
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Goal group (a goal + its nested tasks) ──────────────────────────────────

/** One goal as a collapsible lane. The header is the control surface — a state
 *  dot, the title, a done/total bar, the plain status lead, and ONE primary
 *  control (Start · Pause · Resume). Expand it and the goal's tasks list as rows,
 *  with its past runs rolling up at the foot. Default-open unless the goal is
 *  already finished, so live goals show their tasks and the done tail stays tidy. */
function GoalGroup({
  goal,
  tasks,
  runs,
  selectedId,
  onSelect,
  onRetry,
  forceOpen,
  acting,
  anyActing,
  onRun,
  onPause,
  onResume,
}: {
  goal: GoalSummary;
  tasks: IndexedTask[];
  runs: RunRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry?: (id: string) => void;
  /** Force the lane open (search is active — every match must be visible). */
  forceOpen?: boolean;
  acting: boolean;
  anyActing: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const a = goalAffordances(goal);
  const [openState, setOpen] = useState(!a.finished);
  const open = forceOpen || openState;
  const [showAll, setShowAll] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const disabled = anyActing && !acting;
  const accent = goalAccent(goal);
  const glyph = goalGlyph(goal);
  const running = goal.working > 0;
  const pct = goal.total > 0 ? Math.round((goal.done / goal.total) * 100) : 0;

  const shown = showAll ? tasks : tasks.slice(0, GROUP_ROW_CAP);
  const more = tasks.length - shown.length;

  return (
    <div
      className="overflow-hidden rounded-[6px] border border-line-soft"
      style={{ boxShadow: "var(--shadow-raised-100)" }}
    >
      {/* Header — a raised strip that reads unmistakably as the group header
          (its own tone + a bottom hairline), distinct from the recessed well of
          task cards below. Toggle on the left (chevron + status glyph + title +
          progress), the one primary control on the right. */}
      <div className="flex items-start gap-2 border-b border-line-soft bg-bg-2 px-2.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          title={open ? "Hide this goal's tasks" : "Show this goal's tasks"}
        >
          <ChevronRight
            size={13}
            className="mt-0.5 shrink-0 text-text-5 transition-transform"
            style={{ transform: open ? "rotate(90deg)" : undefined }}
          />
          <span className="mt-px shrink-0">
            <StateGlyph group={glyph.group} color={glyph.color} size={11} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold leading-snug text-text-1">
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
        </button>
        <GoalControl
          affordances={a}
          running={running}
          acting={acting}
          disabled={disabled}
          onRun={onRun}
          onPause={onPause}
          onResume={onResume}
        />
      </div>

      {/* Tasks — the goal's members, nested in a recessed well so each card
          reads as a distinct, raised child of the header above. */}
      {open ? (
        <div className="bg-bg-1 px-2 py-2">
          {shown.length > 0 ? (
            <div className="space-y-1.5">
              {shown.map((it, i) => (
                <TaskRow
                  key={it.task.id}
                  it={it}
                  order={it.status === "ready" ? i + 1 : undefined}
                  selected={it.task.id === selectedId}
                  onSelect={onSelect}
                  onRetry={onRetry}
                />
              ))}
            </div>
          ) : (
            <p className="px-1 py-1.5 text-[11px] text-text-5">
              No tasks resolved yet.
            </p>
          )}
          {more > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 inline-flex items-center gap-1 px-1 text-[11px] text-text-3 hover:text-text-1"
            >
              <ChevronRight size={12} />
              Show {more} more
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Past runs for this goal, collapsed. */}
      {runs.length > 0 ? (
        <div className="border-t border-line-soft bg-bg-1">
          <button
            type="button"
            onClick={() => setRunsOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[11px] text-text-4 hover:text-text-2"
          >
            <ChevronRight
              size={12}
              className="transition-transform"
              style={{ transform: runsOpen ? "rotate(90deg)" : undefined }}
            />
            <History size={11} className="text-text-5" />
            {runs.length} past run{runs.length === 1 ? "" : "s"}
            <span className="text-text-5">
              · latest {relativeTime(runs[0]!.started_at)}
            </span>
          </button>
          {runsOpen ? (
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

/** The one primary control on a goal lane — Resume when parked, Pause while an
 *  agent's on it, Start when there's ready work. Start/Resume wear the same
 *  metallic 3D "go" button the rest of the app uses for create/run CTAs. */
function GoalControl({
  affordances,
  running,
  acting,
  disabled,
  onRun,
  onPause,
  onResume,
}: {
  affordances: ReturnType<typeof goalAffordances>;
  running: boolean;
  acting: boolean;
  disabled: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const spinner = <AsciiSpinner className="text-[12px]" />;
  if (affordances.canResume) {
    return (
      <Button
        variant="accentSoft"
        size="xs"
        onClick={onResume}
        disabled={disabled}
        className="shrink-0 gap-1"
        title="Un-pause this goal's tasks"
      >
        {acting ? spinner : <Play size={12} />}
        Resume
      </Button>
    );
  }
  if (running) {
    return (
      <Button
        variant="subtle"
        size="xs"
        onClick={onPause}
        disabled={disabled}
        className="shrink-0 gap-1 text-text-4"
        title="Park this goal's tasks out of the queue"
      >
        {acting ? spinner : <Pause size={12} />}
        Pause
      </Button>
    );
  }
  if (affordances.canRun) {
    return (
      <Button
        variant="accentSoft"
        size="xs"
        onClick={onRun}
        disabled={disabled}
        className="shrink-0 gap-1"
        title="Put an agent on this goal's ready tasks"
      >
        {acting ? spinner : <Play size={12} />}
        Start
      </Button>
    );
  }
  return null;
}

// ─── Loose tasks (no goal) ───────────────────────────────────────────────────

/** Tasks the board handed us that belong to no goal — collapsed under "Other
 *  tasks" so they don't crowd the goals, but never hidden. Same row shape as a
 *  goal's tasks. */
function OtherTasks({
  tasks,
  selectedId,
  onSelect,
  onRetry,
  forceOpen,
}: {
  tasks: IndexedTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry?: (id: string) => void;
  forceOpen?: boolean;
}) {
  const [openState, setOpen] = useState(true);
  const open = forceOpen || openState;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? tasks : tasks.slice(0, GROUP_ROW_CAP);
  const more = tasks.length - shown.length;
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center gap-1.5 px-0.5 text-left"
      >
        <ChevronRight
          size={13}
          className="shrink-0 text-text-5 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className="text-[11.5px] font-semibold text-text-1">Other tasks</span>
        <span className="text-[11px] tabular-nums text-text-4">{tasks.length}</span>
        <span className="ml-0.5 truncate text-[10.5px] text-text-5">
          not part of a goal
        </span>
      </button>
      {open ? (
        <>
          <div className="space-y-1.5">
            {shown.map((it, i) => (
              <TaskRow
                key={it.task.id}
                it={it}
                order={it.status === "ready" ? i + 1 : undefined}
                selected={it.task.id === selectedId}
                onSelect={onSelect}
                onRetry={onRetry}
              />
            ))}
          </div>
          {more > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 inline-flex items-center gap-1 px-1 text-[11px] text-text-3 hover:text-text-1"
            >
              <ChevronRight size={12} />
              Show {more} more
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// ─── One task row ────────────────────────────────────────────────────────────

/** One task as a compact row — the single card shape the whole tree uses. A
 *  leading status glyph (the SAME shape vocabulary the tasks board draws) reads
 *  its lifecycle at a glance; the agent logo says who's on it; a plain sub-line
 *  carries the detail. Ready work shows its pick position; high/critical work a
 *  priority chip; a FAILED task says so and offers a one-click Retry right here.
 *  Click selects it (highlighting its node on the canvas + opening the drawer). */
function TaskRow({
  it,
  order,
  selected,
  onSelect,
  onRetry,
}: {
  it: IndexedTask;
  order?: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { task, status, unmet } = it;
  const pk = priorityKey(task.priority);
  const failed = status === "failed";
  const showPriority = !failed && (pk === "critical" || pk === "high");
  const err = (task.error_message ?? "").trim();
  return (
    <div
      className="flex w-full items-center gap-2 rounded-lg border bg-bg-0 pl-2.5 pr-2 py-2 shadow-[var(--shadow-card)] transition-colors hover:bg-bg-2"
      style={{
        borderColor: selected ? "var(--color-accent)" : "var(--color-line-soft)",
        boxShadow: selected ? "0 0 0 1px var(--color-accent)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="shrink-0" title={statusLabel(status)}>
          <StatusGlyph status={status} size={10} />
        </span>
        <AgentBit
          agentKind={task.agent_kind}
          size={16}
          dim={status === "done" || status === "paused"}
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[12px] leading-snug text-text-1"
            title={task.title}
          >
            {task.title}
          </div>
          {status === "working" ? (
            <div className="mt-0.5">
              <WorkingLine agentKind={task.agent_kind} />
            </div>
          ) : failed ? (
            <div
              className="mt-0.5 truncate text-[10px] font-medium"
              style={{ color: CREW_ACCENT.failed }}
              title={err || "Run stopped — needs a retry"}
            >
              Failed{err ? ` · ${err}` : ""}
            </div>
          ) : status === "blocked" && unmet ? (
            <div className="mt-0.5 text-[10px] text-text-4">
              waiting on {unmet} {unmet === 1 ? "task" : "tasks"}
            </div>
          ) : status === "paused" ? (
            <div className="mt-0.5 text-[10px] text-text-4">paused — resumable</div>
          ) : status === "done" && task.commit_sha ? (
            <div className="mt-0.5">
              <CommitChip sha={task.commit_sha} />
            </div>
          ) : null}
        </div>
        {showPriority ? <PriorityChip priority={task.priority} /> : null}
        {order !== undefined && !failed ? (
          <span
            className="shrink-0 text-[9.5px] font-semibold tabular-nums text-text-4"
            title={`Runs #${order}`}
          >
            #{order}
          </span>
        ) : null}
      </button>
      {failed && onRetry ? (
        <Button
          variant="subtle"
          size="xs"
          onClick={() => onRetry(task.id)}
          className="shrink-0 gap-1"
          style={{ color: CREW_ACCENT.failed }}
          title="Re-arm this task and run it again"
        >
          <RotateCcw size={11} />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Plain-language label for a lifecycle status — the glyph's tooltip. */
function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "working":
      return "An agent is on it";
    case "ready":
      return "Ready to start";
    case "blocked":
      return "Waiting on earlier work";
    case "paused":
      return "Paused — held back";
    case "failed":
      return "Failed — needs a retry";
    case "done":
      return "Done";
    default:
      return "Queued";
  }
}

// ─── Shared bits (glance, crews, progress, runs) ─────────────────────────────

/** Where the whole queue stands, in one glance: a stacked bar of status colours
 *  + a legend. Status-driven — "what's the shape of my work right now". */
function StatusOverview({ view }: { view: ReadyViewDto }) {
  const shape: Array<{ key: string; label: string; color: string; n: number }> = [
    { key: "working", label: "in progress", color: CREW_ACCENT.working, n: view.counts?.working ?? view.working.length },
    { key: "ready", label: "ready", color: CREW_ACCENT.ready, n: view.counts?.ready ?? view.ready.length },
    { key: "blocked", label: "blocked", color: CREW_ACCENT.blocked, n: view.counts?.blocked ?? view.blocked.length },
    { key: "paused", label: "paused", color: "var(--color-text-4)", n: view.counts?.paused ?? view.paused.length },
    { key: "done", label: "done", color: CREW_ACCENT.done, n: view.counts?.done ?? view.done.length },
  ];
  const segments = shape.filter((s) => s.n > 0);
  const total = segments.reduce((n, s) => n + s.n, 0);
  if (total === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-2">
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
            title={`${s.n} ${s.label}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {segments.map((s) => (
          <span
            key={s.key}
            className="inline-flex items-center gap-1 text-[10.5px] text-text-4"
          >
            <StatusGlyph status={s.key} size={9} />
            <span className="tabular-nums text-text-2">{s.n}</span>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The slim done/total bar fronting a goal lane — fill tinted by the goal's
 *  state, with a quiet tabular "done/total" beside it. */
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
      <span className="block h-1 w-20 shrink-0 overflow-hidden rounded-full bg-bg-0">
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

/** The one quiet plain-language read beside a goal's progress bar — what the
 *  goal needs from you now. */
function GoalLead({ goal }: { goal: GoalSummary }) {
  const a = goalAffordances(goal);
  if (goal.working > 0) {
    return (
      <span className="text-[11px] font-medium" style={{ color: CREW_ACCENT.working }}>
        An agent is on it{goal.working > 1 ? ` · ${goal.working} in flight` : ""}
      </span>
    );
  }
  if (a.finished) {
    return (
      <span className="text-[11px] font-medium" style={{ color: CREW_ACCENT.done }}>
        Done{goal.failed > 0 ? ` · ${goal.failed} couldn't finish` : ""}
      </span>
    );
  }
  if (goal.failed > 0) {
    return (
      <span className="text-[11px] font-medium" style={{ color: CREW_ACCENT.failed }}>
        {goal.failed} couldn't finish
      </span>
    );
  }
  if (goal.ready > 0) {
    return (
      <span className="text-[11px] font-medium" style={{ color: "var(--color-accent)" }}>
        {goal.ready} ready to start
      </span>
    );
  }
  if (goal.paused > 0) {
    return <span className="text-[11px] text-text-4">Paused</span>;
  }
  return <span className="text-[11px] text-text-4">Queued</span>;
}

/** The state colour for a goal's dot + progress fill — amber while an agent
 *  works, red on a failure, green when finished, accent when there's ready work,
 *  muted otherwise. Green/red are status-only. */
function goalAccent(g: GoalSummary): string {
  if (g.working > 0) return CREW_ACCENT.working;
  if (g.failed > 0) return CREW_ACCENT.failed;
  if (g.total > 0 && g.done >= g.total) return CREW_ACCENT.done;
  if (g.ready > 0) return "var(--color-accent)";
  return "var(--color-text-5)";
}

/** A goal's state as the SAME per-group glyph the tasks board draws: half-fill
 *  while an agent works, filled red on a failure, filled green when finished,
 *  a solid ring when there's ready work, a dashed ring when it's just queued. */
function goalGlyph(g: GoalSummary): { group: string; color: string } {
  if (g.working > 0) return { group: "started", color: CREW_ACCENT.working };
  if (g.failed > 0) return { group: "completed", color: CREW_ACCENT.failed };
  if (g.total > 0 && g.done >= g.total)
    return { group: "completed", color: CREW_ACCENT.done };
  if (g.ready > 0) return { group: "unstarted", color: "var(--color-accent)" };
  return { group: "backlog", color: "var(--color-text-5)" };
}

// ─── Crews tab (the workstream switcher) ─────────────────────────────────────

/** The "Crews" view: pick which workstream scopes the plan, see each crew's
 *  shape at a glance, and spawn a new one. A crew is a parallel lane of the same
 *  graph — its own goals + tasks, drained as one loop — so a project can run
 *  several at once (e.g. one for the app, one for mobile) and each agent takes
 *  the next ready task in its crew. Picking a crew scopes the plan and returns
 *  to the tree. */
function CrewsTab({
  view,
  crews,
  activeCrew,
  onPick,
  onSpawnCrew,
}: {
  view: ReadyViewDto;
  crews: CrewRow[];
  activeCrew: string | null;
  onPick: (id: string | null) => void;
  onSpawnCrew: (title: string) => Promise<void>;
}) {
  // "All crews" rolls up the whole graph — use the view's overall counts.
  const allCounts = {
    working: view.counts?.working ?? view.working.length,
    ready: view.counts?.ready ?? view.ready.length,
    blocked: view.counts?.blocked ?? view.blocked.length,
    done: view.counts?.done ?? view.done.length,
    total:
      (view.counts?.working ?? view.working.length) +
      (view.counts?.ready ?? view.ready.length) +
      (view.counts?.blocked ?? view.blocked.length) +
      (view.counts?.paused ?? view.paused.length) +
      (view.counts?.done ?? view.done.length),
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-6 pt-2">
      <p className="px-0.5 text-[11px] leading-relaxed text-text-4">
        A crew is a parallel workstream — its own goals and tasks, worked as one
        loop. Run several side by side; each agent picks up the next ready task
        in its crew.
      </p>

      <div className="flex flex-col gap-1.5">
        <CrewCard
          title="All crews"
          subtitle="Everything, every workstream"
          counts={allCounts}
          goals={view.goals.length}
          active={activeCrew === null}
          onClick={() => onPick(null)}
        />
        {crews.map((c) => (
          <CrewCard
            key={c.meta.id}
            title={c.meta.title}
            subtitle={c.meta.description ?? undefined}
            counts={{
              working: c.summary.working,
              ready: c.summary.ready,
              blocked: c.summary.blocked,
              done: c.summary.done,
              total: c.summary.total,
            }}
            goals={c.summary.goals.length}
            active={activeCrew === c.meta.id}
            onClick={() => onPick(c.meta.id)}
          />
        ))}
      </div>

      <NewCrew onSpawnCrew={onSpawnCrew} />
    </div>
  );
}

/** One crew as a selectable card — its name, a plain "N goals · M tasks" read,
 *  a thin status bar of its shape, and a live indicator when an agent is on it.
 *  The active crew wears an accent ring. */
function CrewCard({
  title,
  subtitle,
  counts,
  goals,
  active,
  onClick,
}: {
  title: string;
  subtitle?: string;
  counts: { working: number; ready: number; blocked: number; done: number; total: number };
  goals: number;
  active: boolean;
  onClick: () => void;
}) {
  const segments = [
    { key: "working", color: CREW_ACCENT.working, n: counts.working },
    { key: "ready", color: CREW_ACCENT.ready, n: counts.ready },
    { key: "blocked", color: CREW_ACCENT.blocked, n: counts.blocked },
    { key: "done", color: CREW_ACCENT.done, n: counts.done },
  ].filter((s) => s.n > 0);
  const barTotal = segments.reduce((n, s) => n + s.n, 0);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-2 rounded-lg border bg-bg-0 px-2.5 py-2.5 text-left shadow-[var(--shadow-card)] transition-colors hover:bg-bg-2"
      style={{
        borderColor: active ? "var(--color-accent)" : "var(--color-line-soft)",
        boxShadow: active ? "0 0 0 1px var(--color-accent)" : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
          style={{ background: "var(--color-bg-2)" }}
        >
          <Users size={13} className="text-text-3" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-text-1">{title}</div>
          <div className="truncate text-[10.5px] text-text-5">
            {subtitle ?? `${goals} ${goals === 1 ? "goal" : "goals"} · ${counts.total} ${counts.total === 1 ? "task" : "tasks"}`}
          </div>
        </div>
        {counts.working > 0 ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium"
            style={{ color: CREW_ACCENT.working }}
          >
            <AsciiSpinner className="text-[11px]" />
            {counts.working}
          </span>
        ) : null}
      </div>
      {barTotal > 0 ? (
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
          {segments.map((s) => (
            <div key={s.key} style={{ width: `${(s.n / barTotal) * 100}%`, background: s.color }} />
          ))}
        </div>
      ) : (
        <div className="text-[10.5px] text-text-5">No tasks yet</div>
      )}
    </button>
  );
}

/** Spawn a second crew to run alongside the others — inline name field. */
function NewCrew({ onSpawnCrew }: { onSpawnCrew: (title: string) => Promise<void> }) {
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

  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
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
          placeholder="Crew name (e.g. Mobile)"
          className="h-7 flex-1 text-[12px]"
        />
        <Button
          variant="accentSoft"
          size="xs"
          onClick={() => void submit()}
          disabled={!name.trim() || spawning}
        >
          {spawning ? <AsciiSpinner className="text-[12px]" /> : "Add"}
        </Button>
      </div>
    );
  }
  return (
    <Button
      variant="subtle"
      size="sm"
      onClick={() => setAdding(true)}
      className="w-full justify-center gap-1.5 text-text-3"
      title="Spawn a second crew to run alongside this one"
    >
      <Plus size={13} />
      New crew
    </Button>
  );
}

/** The crew's whole-queue run history, collapsed by default. */
function PastRuns({ runs }: { runs: RunRecord[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center gap-1.5 px-0.5 text-left"
      >
        <ChevronRight
          size={13}
          className="shrink-0 text-text-5 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        <History size={12} className="text-text-5" />
        <span className="text-[11.5px] font-semibold text-text-1">Past runs</span>
        <span className="text-[10.5px] text-text-5">whole queue, newest first</span>
      </button>
      {open ? (
        <div className="overflow-hidden rounded-[6px] border border-line-soft bg-bg-content">
          {runs.slice(0, 10).map((r, i) => (
            <RunRow key={r.id} run={r} first={i === 0} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** One past run as a quiet row — scope, a plain outcome read, the commit it
 *  landed, and "2m ago". */
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
  const tone = run.failed > 0 ? "red" : run.completed > 0 ? "green" : "neutral";
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 px-3 py-2 text-[11px]",
        first ? "" : "border-t border-line-soft",
        compact ? "bg-bg-1/40" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-text-2">{runScopeLabel(run)}</span>
        <StatusChip tone={tone} dense>
          {runOutcomeLabel(run)}
        </StatusChip>
        {commit ? <CommitChip sha={commit} /> : null}
      </div>
      <span className="shrink-0 whitespace-nowrap tabular-nums text-text-5">
        {relativeTime(run.started_at)}
      </span>
    </div>
  );
}
