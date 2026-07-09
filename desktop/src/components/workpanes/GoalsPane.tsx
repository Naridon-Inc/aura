// GoalsPane — "your tasks, and whether the code proves them done."
//
// The list-first reframe of Goals (behind GOALS_V2). A goal isn't a scraped chat
// line — it's a thing you put on the board and told the AI to build. So this
// opens to your real task board (curated, this-project, plain-language), and for
// each task overlays a plain verdict: Done / Almost / Not yet — meaning "is the
// code that delivers this actually there?" Click one to see, in plain language,
// what's in place and what's still missing, with the AST detail tucked behind a
// "show how you know" disclosure.
//
// The tension this surfaces is the point: a task marked *done* whose proof reads
// *Not yet* is the AI claiming success the code doesn't back up. Proof comes from
// `aura prove --json` via runProveStructured, so every reason is already phrased
// for a human. Checking is lazy: a goal shows its last known status until you
// press Check (or Check all), so opening the page is instant.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { useEditorStore } from "../../lib/editorStore";
import { runProveStructured, type ProveOutcome } from "../../lib/prove";
import { isTaskDone, taskStatusLabel, type TaskGoal } from "../../lib/taskGoals";
import {
  useTaskGoalGroups,
  type GoalGroup,
  type GoalGroupStatus,
} from "../../lib/taskGoalGroups";
import {
  hydrateFromLedger,
  linkTask,
  recordRun,
  upsertGoalByText,
  useGoalsForTask,
  verdictFromOutcome,
  type GoalRun,
  type GoalVerdict,
} from "../../lib/goalStore";
import { ledgerList, ledgerProve } from "../../lib/goalLedger";
import { MeaningPlanePanel } from "../commons/MeaningPlanePanel";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";

type Props = { repoRoot: string; onClose: () => void };

// Plain-language status for each verdict — the user's words, not AST's.
const STATUS: Record<
  GoalVerdict,
  { label: string; glyph: string; color: string; hint: string }
> = {
  verified: {
    label: "Done",
    glyph: "✓",
    color: "var(--color-accent-green)",
    hint: "Everything this task needs is built.",
  },
  partial: {
    label: "Almost",
    glyph: "◐",
    color: "var(--color-amber)",
    hint: "Some of it is built — the rest is still missing.",
  },
  not_wired: {
    label: "Not yet",
    glyph: "○",
    color: "var(--color-red)",
    hint: "None of what this task needs is built yet.",
  },
  unknown: {
    label: "Not checked",
    glyph: "·",
    color: "var(--color-text-4)",
    hint: "Press Check to see whether the AI built this.",
  },
};

export function GoalsPane({ repoRoot, onClose }: Props) {
  const { groups, goals, loading, error } = useTaskGoalGroups(repoRoot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Ephemeral full-proof cache for this mount, keyed by task id. The durable
  // pill (recordRun) only stores counts; this holds the per-check reasons so a
  // detail view can show them without re-running.
  const [outcomes, setOutcomes] = useState<Record<string, ProveOutcome>>({});
  const [checking, setChecking] = useState<Set<string>>(new Set());
  // Task ids whose last check couldn't run (CLI unreachable / bad output).
  // Without this the failure was silent — the pill kept its old verdict and
  // the user couldn't tell "couldn't check" from "not checked yet".
  const [checkErrors, setCheckErrors] = useState<Set<string>>(new Set());

  // Which larger goals are expanded. Default: open the ones with live work,
  // leave finished outcomes (and "Other") collapsed. Seeded once when the board
  // first loads so a user's manual toggles aren't stomped on later reloads.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || groups.length === 0) return;
    seededRef.current = true;
    setExpanded(new Set(groups.filter((g) => g.hasOpenWork && g.id !== "other").map((g) => g.id)));
  }, [groups]);

  // Fold the durable ledger into the reactive store on open, so verdicts,
  // commits, and the files that delivered each goal are present immediately —
  // not just for goals checked in this session. The ledger is git-tracked and
  // team-shared, so this is also how a teammate's proof shows up here.
  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void ledgerList(repoRoot).then((g) => {
      if (alive) hydrateFromLedger(repoRoot, g);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const toggleGroup = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setBusy = useCallback((id: string, on: boolean) => {
    setChecking((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Check one task against the code, through the durable ledger: prove its
  // title (decompose-once, cached), record a run stamped with the commit + the
  // files that deliver it, link it to the task — all persisted in
  // `.aura/goals.jsonl`. Re-hydrate so the pill reflects the canonical ledger.
  // If the CLI is too old to know `goals` (no outcome), fall back to the plain
  // prove + a local run so the surface still works.
  const check = useCallback(
    async (goal: TaskGoal): Promise<ProveOutcome | null> => {
      setBusy(goal.id, true);
      // Clear any prior "couldn't check" flag — this run gets a fresh verdict.
      setCheckErrors((prev) => {
        if (!prev.has(goal.id)) return prev;
        const next = new Set(prev);
        next.delete(goal.id);
        return next;
      });
      try {
        // Prefer the AURA-n handle; fall back to the raw task uuid (the board
        // resolves both) so the goal always links — and its verdict surfaces.
        const taskRef = goal.taskSeq > 0 ? `AURA-${goal.taskSeq}` : goal.taskId || null;
        const outcome = await ledgerProve(repoRoot, goal.text, taskRef);
        if (outcome) {
          const ledger = await ledgerList(repoRoot);
          hydrateFromLedger(repoRoot, ledger);
          setOutcomes((prev) => ({ ...prev, [goal.id]: outcome }));
          return outcome;
        }
        // Fallback for an outdated bundled CLI without `aura goals`.
        const legacy = await runProveStructured(repoRoot, goal.text);
        const { verdict, ok, total } = verdictFromOutcome(legacy);
        const rec = upsertGoalByText(repoRoot, goal.text);
        linkTask(repoRoot, rec.id, goal.taskId, goal.taskSeq);
        recordRun(repoRoot, rec.id, {
          runKey: `task:${goal.taskId}`,
          label: "Check",
          verdict,
          ok,
          total,
          at: Date.now(),
        });
        setOutcomes((prev) => ({ ...prev, [goal.id]: legacy }));
        return legacy;
      } catch {
        // Flag the goal so the row can say "couldn't check" instead of
        // silently leaving the stale verdict in place.
        setCheckErrors((prev) => {
          const next = new Set(prev);
          next.add(goal.id);
          return next;
        });
        return null;
      } finally {
        setBusy(goal.id, false);
      }
    },
    [repoRoot, setBusy],
  );

  // Prove a set of tasks one-by-one (sequential so the CLI isn't hammered and
  // pills land progressively).
  const checkMany = useCallback(
    async (tasks: TaskGoal[]) => {
      for (const t of tasks) {
        // eslint-disable-next-line no-await-in-loop
        await check(t);
      }
    },
    [check],
  );

  // "Check all" proves the open work across every goal — the live question
  // ("is the stuff I'm building really there?"), never the finished pile.
  const openTasks = useMemo(() => goals.filter((g) => !isTaskDone(g.taskStatus)), [goals]);

  const selected = selectedId ? goals.find((g) => g.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <GoalDetail
        repoRoot={repoRoot}
        goal={selected}
        outcome={outcomes[selected.id] ?? null}
        busy={checking.has(selected.id)}
        onCheck={() => void check(selected)}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-0">
      <Header
        onClose={onClose}
        count={openTasks.length}
        onCheckAll={() => void checkMany(openTasks)}
        checking={checking.size > 0}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && goals.length === 0 ? (
          <FillingHint />
        ) : error && goals.length === 0 ? (
          <ErrorHint error={error} />
        ) : goals.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="max-w-[700px] mx-auto px-3 py-3">
            <ul className="space-y-1.5">
              {groups.map((group) => (
                <GroupSection
                  key={group.id}
                  group={group}
                  expanded={expanded.has(group.id)}
                  checkingIds={checking}
                  erroredIds={checkErrors}
                  onToggle={() => toggleGroup(group.id)}
                  onOpenTask={(id) => setSelectedId(id)}
                  onCheckTask={(t) => void check(t)}
                  onCheckGroup={(tasks) => void checkMany(tasks)}
                />
              ))}
            </ul>
            <MeaningSection repoRoot={repoRoot} />
          </div>
        )}
      </div>
      <FooterHint />
    </div>
  );
}

// ── Meaning plane (M4) ───────────────────────────────────────────────────────

// A calm, collapsed-by-default disclosure under the goal list that opens the
// portable "why + proof" record — the same per-commit reasons and proof Aura
// can verify on any clone, on any git host. Collapsed by default so the page
// stays instant (the panel only reads the record once it's actually opened),
// and bounded in height so its own scroll behaves inside this scroll.
function MeaningSection({ repoRoot }: { repoRoot: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line-soft bg-bg-1/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-2/40"
      >
        <ShieldCheck size={13} className="shrink-0 text-text-4" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-text-1">
            Why &amp; proof, on this copy
          </span>
          <span className="block text-[10.5px] leading-tight text-text-3">
            The reason behind each change, and whether it checks out — travels with the repo
          </span>
        </span>
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-text-4" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-text-4" />
        )}
      </button>
      {open && (
        <div className="h-[420px] border-t border-line-soft">
          <MeaningPlanePanel repoRoot={repoRoot} />
        </div>
      )}
    </div>
  );
}

// ── Larger-goal group ────────────────────────────────────────────────────────

// Board-progress status for a whole goal — plain words, status colors only
// (green = done, amber = under way, muted = not started). The proof verdict
// lives on each task underneath; this is "how far along is this outcome".
const GROUP_STATUS: Record<GoalGroupStatus, { label: string; color: string }> = {
  done: { label: "Done", color: "var(--color-accent-green)" },
  in_progress: { label: "In progress", color: "var(--color-amber)" },
  todo: { label: "Not started", color: "var(--color-text-4)" },
};

function GroupSection({
  group,
  expanded,
  checkingIds,
  erroredIds,
  onToggle,
  onOpenTask,
  onCheckTask,
  onCheckGroup,
}: {
  group: GoalGroup;
  expanded: boolean;
  checkingIds: Set<string>;
  erroredIds: Set<string>;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
  onCheckTask: (task: TaskGoal) => void;
  onCheckGroup: (tasks: TaskGoal[]) => void;
}) {
  const s = GROUP_STATUS[group.status];
  const conflictCount = group.tasks.filter(
    (t) => isTaskDone(t.taskStatus) && (t.verdict === "not_wired" || t.verdict === "partial"),
  ).length;
  const open = group.tasks.filter((t) => !isTaskDone(t.taskStatus));
  return (
    <li className="rounded-lg border border-line-soft bg-bg-1/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-2.5 py-2.5 text-left hover:bg-bg-1/50 transition-colors"
        title={expanded ? "Collapse" : "See the tasks under this goal"}
      >
        <Caret open={expanded} />
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[13px] text-text-1 font-medium">{group.title}</span>
          <span className="block truncate text-[10.5px] text-text-4 mt-0.5">{group.meaning}</span>
        </span>
        {conflictCount > 0 && (
          <span
            className="shrink-0 text-[14px] leading-none text-red"
            title={`${conflictCount} marked done, but the code can't back ${conflictCount === 1 ? "it" : "them"} up yet`}
            aria-hidden
          >
            ⚠
          </span>
        )}
        <span className="shrink-0 text-[11px] text-text-3 tabular-nums">
          {group.doneCount}/{group.total}
        </span>
        <span
          className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded tabular-nums"
          style={{
            color: s.color,
            background: `color-mix(in oklab, ${s.color} 12%, transparent)`,
          }}
        >
          {s.label}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2">
          {conflictCount > 0 && (
            <div className="mx-0.5 mb-1.5 text-[10.5px] text-amber">
              {conflictCount} {conflictCount === 1 ? "task is" : "tasks are"} marked done, but a check
              couldn't prove {conflictCount === 1 ? "it" : "them"} yet.
            </div>
          )}
          <ul className="space-y-1">
            {group.tasks.map((t) => (
              <GoalRow
                key={t.id}
                goal={t}
                busy={checkingIds.has(t.id)}
                errored={erroredIds.has(t.id)}
                onOpen={() => onOpenTask(t.id)}
                onCheck={() => onCheckTask(t)}
              />
            ))}
          </ul>
          {open.length > 0 && (
            <button
              type="button"
              onClick={() => onCheckGroup(open)}
              className="mt-1.5 ml-0.5 text-[10.5px] text-text-4 hover:text-text-2 transition-colors"
            >
              Check {open.length === 1 ? "this task" : `these ${open.length}`} against the code
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({
  onClose,
  count,
  onCheckAll,
  checking,
}: {
  onClose: () => void;
  count: number;
  onCheckAll: () => void;
  checking: boolean;
}) {
  return (
    <div className="h-9 px-3 flex items-center gap-2 border-b border-line-soft bg-bg-1/40 shrink-0">
      <GoalGlyph />
      <span className="text-text-1 text-[12px] font-medium">Goals</span>
      <span className="text-text-4 text-[10.5px]">
        the outcomes your tasks add up to — and whether the code proves them
      </span>
      {count > 0 && (
        <button
          type="button"
          onClick={onCheckAll}
          disabled={checking}
          title="Check every shown task against the current code"
          className="ml-auto text-text-3 hover:text-text-1 text-[11px] px-2 py-0.5 rounded hover:bg-bg-2 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check all"}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        className={`text-text-3 hover:text-text-1 text-[11px] px-2 py-0.5 rounded hover:bg-bg-2 ${count > 0 ? "" : "ml-auto"}`}
      >
        ✕
      </button>
    </div>
  );
}

// ── List row ─────────────────────────────────────────────────────────────────

function GoalRow({
  goal,
  busy,
  errored,
  onOpen,
  onCheck,
}: {
  goal: TaskGoal;
  busy: boolean;
  errored?: boolean;
  onOpen: () => void;
  onCheck: () => void;
}) {
  const status = STATUS[busy ? "unknown" : goal.verdict];
  // Fuse the proof tally into the pill ("Almost · 2/3") so a glance reads the
  // verdict AND how close it is — but only with a real check behind it
  // (total > 0 and an actual verdict, never the "not checked" state).
  const showTally =
    !busy && goal.verdict !== "unknown" && goal.total > 0;
  // A check that couldn't run takes precedence over the stale verdict pill —
  // the user needs to know the result they're seeing is old, not fresh.
  const showError = !!errored && !busy;
  // A task the board calls done but proof can't back up — the headline tension.
  const claimsDoneButNot =
    isTaskDone(goal.taskStatus) && (goal.verdict === "not_wired" || goal.verdict === "partial");
  return (
    <li className="group flex items-center gap-2.5 rounded-md border border-line-soft bg-bg-1/30 hover:bg-bg-1/60 hover:border-line transition-colors px-2.5 py-2">
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
        title="See what's built and what's missing"
      >
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 grid place-items-center text-[11px] font-semibold"
          style={{ color: status.color }}
        >
          {busy ? <Spinner /> : status.glyph}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[12.5px] text-text-1">{goal.text}</span>
          <span className="block truncate text-[10px] text-text-4 mt-0.5">
            {goal.taskSeq > 0 ? `AURA-${goal.taskSeq} · ` : ""}
            {taskStatusLabel(goal.taskStatus)}
            {claimsDoneButNot ? (
              <span className="text-amber"> · marked done, but not proven</span>
            ) : null}
          </span>
        </span>
      </button>
      {showError ? (
        <span
          className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded text-rose-300"
          style={{
            background: "color-mix(in oklab, var(--color-rose, #f43f5e) 12%, transparent)",
          }}
          title="The checker couldn't run — check your setup and try again."
        >
          Couldn't check
        </span>
      ) : (
        <span
          className="shrink-0 text-[10.5px] tabular-nums px-1.5 py-0.5 rounded"
          style={{
            color: status.color,
            background: `color-mix(in oklab, ${status.color} 12%, transparent)`,
          }}
          title={status.hint}
        >
          {busy ? (
            "Checking…"
          ) : (
            <>
              {status.label}
              {showTally ? (
                <span className="ml-1 font-normal tabular-nums opacity-70">
                  · {goal.ok}/{goal.total}
                </span>
              ) : null}
            </>
          )}
        </span>
      )}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <RowAction title="Check this task against the code now" onClick={onCheck} disabled={busy}>
          Check
        </RowAction>
      </div>
    </li>
  );
}

function RowAction({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="text-[10.5px] text-text-3 hover:text-text-1 px-1.5 py-0.5 rounded hover:bg-bg-2 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function GoalDetail({
  repoRoot,
  goal,
  outcome,
  busy,
  onCheck,
  onBack,
}: {
  repoRoot: string;
  goal: TaskGoal;
  outcome: ProveOutcome | null;
  busy: boolean;
  onCheck: () => void;
  onBack: () => void;
}) {
  const editor = useEditorStore();
  // Prefer the freshly-checked outcome; fall back to the stored verdict.
  const verdict: GoalVerdict = outcome ? verdictFromOutcome(outcome).verdict : goal.verdict;
  const status = STATUS[busy ? "unknown" : verdict];
  const missing = outcome?.checks.filter((c) => !c.passed) ?? [];
  const built = outcome?.checks.filter((c) => c.passed) ?? [];
  // The durable ledger record for this task — its newest run carries the commit
  // and the files that deliver this goal (the reverse code↔goal link), and its
  // cached decomposition is the plain "what this needs" before any fresh check.
  const records = useGoalsForTask(repoRoot, goal.taskId);
  const record = records[0] ?? null;
  const latestRun: GoalRun | null = record?.runs[0] ?? null;
  const requirements = record?.decomposition?.requirements ?? [];

  return (
    <div className="h-full w-full flex flex-col bg-bg-0">
      {/* Detail header */}
      <div className="h-9 px-3 flex items-center gap-2 border-b border-line-soft bg-bg-1/40 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="text-text-3 hover:text-text-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-bg-2 flex items-center gap-1"
        >
          <BackCaret /> Goals
        </button>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="default"
            size="xs"
            onClick={onCheck}
            disabled={busy}
            title="Re-check against the current code"
          >
            {busy ? "Checking…" : "Check now"}
          </Button>
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[680px] mx-auto px-4 py-5 space-y-5">
          {/* The ask, verbatim */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-4 mb-1">You asked for</div>
            <div className="text-[15px] text-text-1 leading-snug">{goal.text}</div>
            <div className="text-[10.5px] text-text-4 mt-1.5">
              {goal.taskSeq > 0 ? (
                <button
                  type="button"
                  onClick={() => editor.openTaskDetail(goal.taskId, repoRoot)}
                  className="text-accent hover:underline font-mono"
                >
                  AURA-{goal.taskSeq}
                </button>
              ) : null}
              {goal.taskSeq > 0 ? " · " : ""}
              {taskStatusLabel(goal.taskStatus)} on the board
            </div>
            {goal.description.trim() ? (
              <p className="mt-2.5 text-[12px] text-text-3 leading-relaxed whitespace-pre-wrap line-clamp-6">
                {goal.description.trim()}
              </p>
            ) : null}
          </div>

          {/* Status hero — verdict first, with the proof tally fused into the
              headline ("Almost · 2/3 checks") so the one line a reader trusts
              also says how close it is. Real counts from the structured proof;
              no fabricated score when nothing was checked. */}
          <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px]" style={{ color: status.color }} aria-hidden>
                {busy ? <Spinner /> : status.glyph}
              </span>
              <span className="text-[13px] font-semibold text-text-1">
                {status.label}
                {!busy && outcome && outcome.total > 0 ? (
                  <span className="ml-1.5 text-[12px] font-normal text-text-4 tabular-nums">
                    · {outcome.passed}/{outcome.total} checks
                  </span>
                ) : null}
              </span>
            </div>
            <div className="text-[12.5px] text-text-2 mt-1.5 leading-snug">
              {busy
                ? "Checking what's built…"
                : outcome?.error
                  ? friendlyError(outcome.error)
                  : isTaskDone(goal.taskStatus) && (verdict === "not_wired" || verdict === "partial")
                    ? "This task is marked done on the board — but the code doesn't fully back that up yet."
                    : status.hint}
            </div>
          </div>

          {/* Where this goal lives in the code — the reverse link, from the
              durable ledger (which build delivered it, in which files). */}
          {latestRun && <DeliveredBy run={latestRun} />}

          {/* The "why it's not slop": the concrete parts this goal was broken
              into. Shown before a fresh check so you can see what's being looked
              for — these are the same parts the proof checks against. */}
          {!outcome && !busy && requirements.length > 0 && (
            <section>
              <div className="text-[10.5px] uppercase tracking-wider text-text-4 font-medium">
                What this needs
                <span className="ml-1.5 tabular-nums normal-case tracking-normal">
                  {requirements.length}
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {requirements.map((r, i) => (
                  <li
                    key={`${r.nodeName}-${i}`}
                    className="flex items-start gap-2.5 text-[12px] px-2.5 py-1.5 rounded border border-line-soft bg-bg-1/30"
                  >
                    <span className="shrink-0 mt-px text-[11px] text-text-4" aria-hidden>
                      ·
                    </span>
                    <span className="flex-1 min-w-0 text-text-2">
                      {r.nodeName}
                      {r.mustCall ? (
                        <span className="text-text-4"> → reaches {r.mustCall}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-[11px] text-text-5">
                Press <span className="text-text-3">Check now</span> to see which of these the code
                actually has.
              </div>
            </section>
          )}

          {/* Plain proof — what's missing, then what's there */}
          {!outcome && !busy && requirements.length === 0 && (
            <div className="text-text-4 text-[12px] text-center py-4">
              Press <span className="text-text-2">Check now</span> to see what the AI built and what's
              still missing.
            </div>
          )}
          {missing.length > 0 && <ProofGroup title="Still missing" tone="bad" checks={missing} />}
          {built.length > 0 && <ProofGroup title="In place" tone="good" checks={built} />}

          {/* AST detail on demand */}
          {outcome && outcome.checks.length > 0 && <HowYouKnow outcome={outcome} />}

          {/* Jump to the task on the board */}
          <div className="pt-2 border-t border-line-soft">
            <button
              type="button"
              onClick={() => editor.openTaskDetail(goal.taskId, repoRoot)}
              className="text-[11px] text-text-4 hover:text-text-2 transition-colors"
            >
              Open this task on the board →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// A plain-language group of proof lines (the reasons, not the AST names).
function ProofGroup({
  title,
  tone,
  checks,
}: {
  title: string;
  tone: "good" | "bad";
  checks: ProveOutcome["checks"];
}) {
  const color = tone === "good" ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <section>
      <div className="text-[10.5px] uppercase tracking-wider text-text-4 font-medium">
        {title}
        <span className="ml-1.5 tabular-nums normal-case tracking-normal">{checks.length}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {checks.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-[12px] px-2.5 py-1.5 rounded border border-line-soft bg-bg-1"
          >
            <span className="shrink-0 mt-px text-[11px]" style={{ color }} aria-hidden>
              {tone === "good" ? "✓" : "✗"}
            </span>
            <span className="flex-1 min-w-0 text-text-1">{c.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// "Delivered by" — the reverse code↔goal link, in plain words. The newest run
// in the ledger knows which commit last checked this goal and which files its
// parts live in, so you can see what code actually backs the outcome.
function DeliveredBy({ run }: { run: GoalRun }) {
  const files = run.files ?? [];
  if (files.length === 0 && !run.commit) return null;
  const when = run.at ? new Date(run.at).toLocaleDateString() : null;
  return (
    <section className="rounded-lg border border-line-soft bg-bg-1/30 px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-4 mb-1.5">Delivered by</div>
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span
              key={f}
              className="text-[11px] font-mono text-text-2 px-1.5 py-0.5 rounded bg-bg-2/60 border border-line-soft truncate max-w-full"
              title={f}
            >
              {f}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11.5px] text-text-4">Checked, but no files were pinpointed yet.</div>
      )}
      {(run.commit || when) && (
        <div className="text-[10.5px] text-text-5 mt-2">
          {run.commit ? (
            <>
              last checked at commit <span className="font-mono text-text-4">{run.commit}</span>
            </>
          ) : null}
          {run.commit && when ? " · " : ""}
          {when ?? ""}
        </div>
      )}
    </section>
  );
}

// The mechanism, on demand only — the AST node names behind each plain reason.
function HowYouKnow({ outcome }: { outcome: ProveOutcome }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line-soft pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[11px] text-text-3 hover:text-text-1 transition-colors"
      >
        <Caret open={open} />
        <span>Show how you know ({outcome.checks.length} checks)</span>
      </button>
      {open && (
        <ul className="mt-2.5 space-y-0.5">
          {outcome.checks.map((c, i) => (
            <li
              key={i}
              className={`flex items-start gap-2 px-2 py-1 rounded text-[11.5px] font-mono ${
                i % 2 === 0 ? "bg-bg-1/30" : ""
              }`}
            >
              <span className={`shrink-0 mt-0.5 text-[11px] ${c.passed ? "text-green" : "text-red"}`}>
                {c.passed ? "✓" : "✗"}
              </span>
              <span className="flex-1 min-w-0 truncate" title={c.reason}>
                <span className="text-text-4">{c.node_type}</span>{" "}
                <span className="text-text-1">{c.node_name}</span>
                {c.must_call ? <span className="text-text-4"> → calls {c.must_call}</span> : null}
                {c.is_stub ? <span className="text-amber"> · placeholder</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Empty / filling states ───────────────────────────────────────────────────

function FillingHint() {
  return (
    <div className="text-text-4 text-[12px] py-10 text-center flex flex-col items-center gap-2">
      <Spinner />
      <span>Reading your task board…</span>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="text-text-4 text-[11.5px] py-12 px-6 text-center max-w-md mx-auto leading-relaxed">
      Your goals are your tasks. Add a task on the board — describing what should work when it&apos;s
      done — and it shows up here with a plain status so you can see whether the AI actually built it,
      or left it half-finished.
    </div>
  );
}

function ErrorHint({ error }: { error: string }) {
  return (
    <div className="text-text-4 text-[11.5px] py-12 px-6 text-center max-w-md mx-auto leading-relaxed">
      Couldn&apos;t read the task board.
      <div className="mt-1.5 text-[10.5px] text-text-5 font-mono break-words">{error}</div>
    </div>
  );
}

function FooterHint() {
  return (
    <div className="border-t border-line-soft bg-bg-1/20 px-3 py-1.5 shrink-0">
      <span className="text-[10.5px] text-text-5">
        Each goal groups the tasks that deliver it — open one to check them against the real code.
      </span>
    </div>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function friendlyError(error: string): string {
  // The CLI's "can't tell yet" — keep it calm and non-technical.
  return error;
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function BackCaret() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
      <path d="M8 2.5 4 6l4 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function GoalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 8.5l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
