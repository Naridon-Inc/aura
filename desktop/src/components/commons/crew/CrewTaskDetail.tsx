// Crew · Task detail — click any task (in the graph, a lane, or the activity
// feed) and the worklist sidebar SWAPS to this: the whole story of that task,
// right where the list was. A vibecoder told us a separate side-popover wasn't a
// great idea — so this is master→detail in one column, not an overlay. A "back"
// row returns to the list; Esc does the same.
//
// It reads like a proper brief, not a dump:
//   • the spec + "done when" render as real MARKDOWN (headings, lists, code),
//   • who's on it / where it sits (goal, objective, sprint) are PROPER CHIPS,
//   • "Waiting on" / "Unblocks" are COLLAPSIBLE sections whose rows are the real
//     tasks — click one to jump straight to its detail,
//   • and a plain-language line explains WHY each arrow exists, so the lines on
//     the board stop being a mystery.
//
// Everything resolves from the same `allTasks` the shell already holds — no new
// fetch. Failed tasks get a Retry; in-flight ones get a Release (hand it back to
// the queue) so a wedged run is never stuck.

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CornerDownRight,
  Loader2,
  Play,
  RotateCcw,
  Send,
} from "lucide-react";

import type { LoopTask } from "../../../lib/api";
import { Button } from "../../ui/button";
import { StatusChip, type ChipSpec } from "../../ui/statusChip";
import { TaskMarkdown } from "../../tasks/TaskMarkdown";
import { bestProof, proofForCommit, type CrewProof } from "./crewProof";
import {
  AgentBit,
  AssigneeBit,
  CommitChip,
  CREW_ACCENT,
  PriorityChip,
  ProofPill,
  ProvenanceChips,
  relativeTime,
} from "./crewShared";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";

type Lifecycle = "ready" | "working" | "blocked" | "paused" | "done" | "failed";

/** Plain-language lifecycle → chip. Arctic-blue (blue tone) for ready, amber
 *  while an agent works, green for done, red for failed, muted for blocked or
 *  paused. */
const LIFECYCLE_CHIP: Record<Lifecycle, ChipSpec> = {
  ready: { tone: "blue", label: "Ready to start" },
  working: { tone: "amber", label: "An agent is on it" },
  blocked: { tone: "neutral", label: "Waiting on earlier work" },
  paused: { tone: "neutral", label: "Paused — held back" },
  done: { tone: "green", label: "Done" },
  failed: { tone: "red", label: "Failed" },
};

/** Plain-language lifecycle, derived from the node's status + whether its
 *  dependencies have actually finished — never the raw enum on screen. */
function lifecycleOf(task: LoopTask, byId: Map<string, LoopTask>): Lifecycle {
  const s = task.status;
  if (s === "completed" || s === "done") return "done";
  if (s === "working" || s === "in_progress" || s === "leased") return "working";
  if (s === "failed") return "failed";
  if (s === "paused") return "paused";
  const unmet = (task.depends_on ?? []).filter((id) => {
    const dep = byId.get(id);
    return !dep || (dep.status !== "completed" && dep.status !== "done");
  });
  return unmet.length > 0 ? "blocked" : "ready";
}

// ─── Tag readers (local — the layout's own are module-private) ─────────
// `goal:` / `objective:` / `sprint:` carry a colon; imported boards tag
// `wave-a` / `sprint-2` / `prd-09` with a bare dash. We read both.
function tagValue(task: LoopTask, prefix: string): string | null {
  const tag = (task.tags ?? []).find((t) => t.toLowerCase().startsWith(prefix));
  if (!tag) return null;
  const v = tag.slice(tag.indexOf(":") + 1).trim();
  return v || null;
}
function dashTagValue(task: LoopTask, prefix: string): string | null {
  const tag = (task.tags ?? []).find((t) => t.toLowerCase().startsWith(prefix));
  if (!tag) return null;
  const v = tag.slice(prefix.length).trim();
  return v || null;
}

type Placement = {
  goal: string | null;
  objective: string | null;
  sprint: string | null;
  wave: string | null;
  prd: string | null;
};
function placementOf(task: LoopTask): Placement {
  return {
    goal: tagValue(task, "goal:"),
    objective: tagValue(task, "objective:"),
    sprint: dashTagValue(task, "sprint-") ?? tagValue(task, "sprint:"),
    wave: dashTagValue(task, "wave-"),
    prd: dashTagValue(task, "prd-"),
  };
}

/** WHY an arrow exists, in plain words. We don't store a reason, so we infer
 *  the strongest shared context: same goal beats same objective beats same
 *  sprint/wave. Falls back to the bare ordering meaning when nothing's shared. */
function connectionReason(self: LoopTask, other: LoopTask): string {
  const a = placementOf(self);
  const b = placementOf(other);
  if (a.goal && b.goal && a.goal === b.goal)
    return `Both build the goal “${a.goal}”.`;
  if (a.objective && b.objective && a.objective === b.objective)
    return `Both serve “${a.objective}”.`;
  if (a.wave && b.wave && a.wave === b.wave)
    return `Scheduled together in wave ${a.wave}.`;
  if (a.sprint && b.sprint && a.sprint === b.sprint)
    return `Scheduled together in sprint ${a.sprint}.`;
  if (a.prd && b.prd && a.prd === b.prd)
    return `Part of the same spec (${a.prd}).`;
  return "Its result is needed before this can move.";
}

export function CrewTaskDetail({
  task,
  allTasks,
  proof,
  onClose,
  onOpen,
  onSetStatus,
  onRetry,
}: {
  task: LoopTask;
  allTasks: LoopTask[];
  proof: Map<string, CrewProof[]>;
  /** Return to the worklist (the column reverts to the list). */
  onClose: () => void;
  /** Jump to a related task's detail (same column swaps). */
  onOpen: (id: string) => void;
  onSetStatus: (nodeId: string, status: string) => void;
  /** Retry a failed task — re-arm AND run in one click (the shell dispatches
   *  the ready ones and reports what's still waiting). Falls back to a plain
   *  re-queue via onSetStatus when not provided. */
  onRetry?: (nodeId: string) => void;
}) {
  // Esc returns to the list first — captured + stopped so the overlay's own Esc
  // (which closes all of Crew) doesn't also fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const byId = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t])),
    [allTasks],
  );

  const life = lifecycleOf(task, byId);
  const place = useMemo(() => placementOf(task), [task]);

  // "Waiting on" — its dependencies, as real tasks. "Unblocks" — tasks that
  // name this one as a dependency.
  const waitingOn = useMemo(
    () =>
      (task.depends_on ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is LoopTask => !!t),
    [task.depends_on, byId],
  );
  const unblocks = useMemo(
    () => allTasks.filter((t) => (t.depends_on ?? []).includes(task.id)),
    [allTasks, task.id],
  );

  // The FLOW this task belongs to — every step sharing its goal. This is the
  // context that was missing while a task ran: "what all works are there, how
  // much is done." We order it done → in-flight → still-to-come so it reads as
  // a real checklist of the goal's progress, and count how far it's come.
  const flow = useMemo(() => {
    const g = place.goal;
    if (!g) return [] as LoopTask[];
    const rank: Record<Lifecycle, number> = {
      done: 0,
      working: 1,
      ready: 2,
      blocked: 3,
      paused: 4,
      failed: 5,
    };
    return allTasks
      .filter((t) => tagValue(t, "goal:") === g)
      .sort((a, b) => rank[lifecycleOf(a, byId)] - rank[lifecycleOf(b, byId)]);
  }, [allTasks, place.goal, byId]);
  const flowDone = useMemo(
    () => flow.filter((t) => lifecycleOf(t, byId) === "done").length,
    [flow, byId],
  );

  const proofs = proofForCommit(proof, task.commit_sha);
  const best = bestProof(proofs);
  const agentLabel = task.agent_kind
    ? agentDisplayLabel(canonicalAgentId(task.agent_kind))
    : "No agent yet";

  return (
    <div className="flex h-full flex-col bg-bg-content">
      {/* Back to the list — the master→detail return path, in the same column. */}
      <button
        type="button"
        onClick={onClose}
        className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-3.5 py-2 text-left text-[11px] font-medium text-text-4 transition-colors hover:text-text-1"
        title="Back to the worklist (Esc)"
      >
        <ArrowLeft size={13} />
        All tasks
      </button>

      {/* Header — the heading IS the task, with its state as a real chip. */}
      <div className="shrink-0 border-b border-line px-4 py-3.5">
        <h2 className="text-[14.5px] font-semibold leading-snug text-text-1">
          {task.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusChip tone={LIFECYCLE_CHIP[life].tone} dot dense>
            {LIFECYCLE_CHIP[life].label}
          </StatusChip>
          <PriorityChip priority={task.priority} />
          <ProvenanceChips task={task} />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* Who & where — proper components, not a text run. */}
        <div className="space-y-3">
          <FactRow label="Agent">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
              <AgentBit agentKind={task.agent_kind} size={16} />
              {agentLabel}
            </span>
          </FactRow>
          <FactRow label="Assignee">
            {task.assignee?.trim() ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
                <AssigneeBit name={task.assignee.trim()} size={16} />
                {task.assignee.trim()}
              </span>
            ) : (
              <span className="text-[12px] text-text-5">Nobody yet</span>
            )}
          </FactRow>
          {(place.goal ||
            place.objective ||
            place.sprint ||
            place.wave ||
            place.prd) && (
            <FactRow label="Where it sits">
              <div className="flex flex-wrap items-center gap-1.5">
                {place.goal ? (
                  <StatusChip tone="violet" dense className="max-w-full">
                    <span className="min-w-0 truncate">Goal · {place.goal}</span>
                  </StatusChip>
                ) : null}
                {place.objective ? (
                  <StatusChip tone="blue" dense className="max-w-full">
                    <span className="min-w-0 truncate">{place.objective}</span>
                  </StatusChip>
                ) : null}
                {place.wave ? (
                  <StatusChip tone="neutral" dense>
                    Wave {place.wave}
                  </StatusChip>
                ) : null}
                {place.sprint ? (
                  <StatusChip tone="neutral" dense>
                    Sprint {place.sprint}
                  </StatusChip>
                ) : null}
                {place.prd ? (
                  <StatusChip tone="neutral" dense>
                    {place.prd.toUpperCase()}
                  </StatusChip>
                ) : null}
              </div>
            </FactRow>
          )}
          {task.updated_at ? (
            <FactRow label="Last touched">
              <span className="text-[12px] text-text-3">
                {relativeTime(task.updated_at)}
              </span>
            </FactRow>
          ) : null}
        </div>

        {/* Progress — the context that used to be missing the moment a task
            showed "running": where it is in its own life (a step timeline),
            how far its whole goal-flow has come, and a checklist of every step
            in that flow with a real status tick. Shown for everything that
            isn't already finished (done has its own Result block below). */}
        {life !== "done" ? (
          <Section label="Progress">
            <StepTimeline task={task} life={life} />
            {flow.length > 1 ? (
              <FlowProgress
                self={task}
                flow={flow}
                done={flowDone}
                goal={place.goal}
                byId={byId}
                onOpen={onOpen}
              />
            ) : null}
          </Section>
        ) : null}

        {/* The spec — what this task actually asks for, as markdown. */}
        {task.input?.trim() ? (
          <Section label="What this does">
            <TaskMarkdown source={task.input.trim()} />
          </Section>
        ) : null}

        {/* Acceptance criteria — how it knows it's done, as markdown. */}
        {task.acceptance_criteria?.trim() ? (
          <Section label="Done when">
            <TaskMarkdown source={task.acceptance_criteria.trim()} />
          </Section>
        ) : null}

        {/* Connections — the WHY behind the arrows on the board. */}
        {waitingOn.length > 0 || unblocks.length > 0 ? (
          <Section label="Connections">
            <p className="mb-2.5 text-[11.5px] leading-relaxed text-text-4">
              Arrows on the board show the order of work. This task can’t start
              until everything it’s <b className="text-text-3">waiting on</b> is
              done; finishing it frees the tasks it{" "}
              <b className="text-text-3">unblocks</b>.
            </p>
            {waitingOn.length > 0 ? (
              <Collapsible
                title="Waiting on"
                count={waitingOn.length}
                defaultOpen={waitingOn.length <= 8}
              >
                <DepList
                  self={task}
                  tasks={waitingOn}
                  byId={byId}
                  onOpen={onOpen}
                />
              </Collapsible>
            ) : null}
            {unblocks.length > 0 ? (
              <Collapsible
                title="Unblocks"
                count={unblocks.length}
                defaultOpen={unblocks.length <= 8}
              >
                <DepList
                  self={task}
                  tasks={unblocks}
                  byId={byId}
                  onOpen={onOpen}
                />
              </Collapsible>
            ) : null}
          </Section>
        ) : null}

        {/* Done → the commit + the proof + the files it touched. */}
        {life === "done" ? (
          <Section label="Result">
            <div className="flex flex-wrap items-center gap-2">
              {task.commit_sha ? <CommitChip sha={task.commit_sha} /> : null}
              {best ? (
                <ProofPill proof={best} />
              ) : (
                <span className="text-[11px] text-text-5">
                  Not checked against a goal
                </span>
              )}
            </div>
            {best?.goalText ? (
              <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
                Goal: {best.goalText}
              </p>
            ) : null}
            {best && best.files.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {best.files.slice(0, 8).map((f) => (
                  <li
                    key={f}
                    className="truncate font-mono text-[10.5px] text-text-4"
                    title={f}
                  >
                    {f}
                  </li>
                ))}
                {best.files.length > 8 ? (
                  <li className="text-[10.5px] text-text-5">
                    +{best.files.length - 8} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </Section>
        ) : null}

        {/* Failed → the error. */}
        {life === "failed" && (task.error_message ?? "").trim() ? (
          <Section label="What went wrong">
            <p className="whitespace-pre-wrap rounded-md border border-line-soft bg-bg-1/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-[#c2706f]">
              {task.error_message?.trim()}
            </p>
          </Section>
        ) : null}
      </div>

      {/* Footer verbs — only what makes sense for this lifecycle. Each re-arms
          the single node into the ready set (the same primitive Retry/Release
          use); goal-wide pause/resume still lives on the Control tab. */}
      {life === "failed" || life === "working" || life === "paused" ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          {life === "failed" ? (
            <Button
              variant="default"
              size="sm"
              onClick={() =>
                onRetry
                  ? onRetry(task.id)
                  : onSetStatus(task.id, "submitted")
              }
              className="gap-1.5"
              title="Re-queue this task and run it again — an agent picks it up right away (or tells you what it's still waiting on)"
            >
              <RotateCcw size={13} />
              Retry
            </Button>
          ) : life === "paused" ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => onSetStatus(task.id, "submitted")}
              className="gap-1.5"
              title="Un-pause this task — put it back in the ready queue"
            >
              <Play size={13} />
              Resume
            </Button>
          ) : (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => onSetStatus(task.id, "submitted")}
              className="gap-1.5"
              title="Hand this back to the queue so another pass can pick it up"
            >
              <Send size={13} />
              Release
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// A tone → colour for the timeline dots and flow ticks. Green = behind us,
// amber = happening now, muted = still ahead, red = stopped.
const TICK_COLOR: Record<Lifecycle, string> = {
  done: "#3fa66a",
  working: "#d99a2b",
  ready: "#5b8def",
  blocked: "#717c8a",
  paused: "#717c8a",
  failed: "#c2706f",
};

/** This task's own life as a short vertical timeline — the missing answer to
 *  "what's happened and what's next" the instant a card flips to running. Every
 *  step is real: when it was added, when an agent picked it up, and where it is
 *  right now. No invented progress. */
function StepTimeline({ task, life }: { task: LoopTask; life: Lifecycle }) {
  type Step = { label: string; sub?: string; tone: "done" | "now" | "todo" | "fail" };
  const steps: Step[] = [
    {
      label: "Added to the queue",
      sub: task.created_at ? relativeTime(task.created_at) : undefined,
      tone: "done",
    },
  ];
  if (life === "working") {
    steps.push({
      label: "An agent picked it up",
      sub: task.updated_at ? relativeTime(task.updated_at) : undefined,
      tone: "done",
    });
    steps.push({ label: "Working on it now", tone: "now" });
  } else if (life === "ready") {
    steps.push({ label: "Ready — waiting for a free agent", tone: "now" });
  } else if (life === "blocked") {
    steps.push({ label: "Waiting on earlier work to finish", tone: "todo" });
  } else if (life === "paused") {
    steps.push({ label: "Paused — held out of the queue, resumable", tone: "todo" });
  } else if (life === "failed") {
    steps.push({
      label: "Run stopped — needs a retry",
      sub: task.updated_at ? relativeTime(task.updated_at) : undefined,
      tone: "fail",
    });
  }
  const color = (tone: Step["tone"]) =>
    tone === "done"
      ? "#3fa66a"
      : tone === "now"
        ? "#d99a2b"
        : tone === "fail"
          ? "#c2706f"
          : "#717c8a";
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={i} className="flex gap-2.5">
            {/* rail: a dot + a connector down to the next step */}
            <div className="flex w-3 shrink-0 flex-col items-center">
              <span
                className={`mt-1 h-2 w-2 rounded-full ${s.tone === "now" ? "animate-pulse" : ""}`}
                style={{ background: color(s.tone) }}
              />
              {!last ? <span className="w-px flex-1 bg-line" /> : null}
            </div>
            <div className={last ? "pb-0" : "pb-2.5"}>
              <div className="text-[12px] leading-tight text-text-2">
                {s.label}
              </div>
              {s.sub ? (
                <div className="mt-0.5 text-[10.5px] text-text-5">{s.sub}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The whole goal-flow's progress, with this task in it — answers "how much of
 *  the work is done, what's left" without leaving the detail. A bar for the
 *  count, then a foldable checklist of every step with a real status tick; the
 *  current task is marked and the rest jump on click. */
function FlowProgress({
  self,
  flow,
  done,
  goal,
  byId,
  onOpen,
}: {
  self: LoopTask;
  flow: LoopTask[];
  done: number;
  goal: string | null;
  byId: Map<string, LoopTask>;
  onOpen: (id: string) => void;
}) {
  const pct = flow.length > 0 ? Math.round((done / flow.length) * 100) : 0;
  return (
    <div className="mt-3.5 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11.5px] font-medium text-text-3">
          {goal ? `Goal · ${goal}` : "This flow"}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-text-4">
          {done} of {flow.length} done
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "var(--color-accent)" }}
        />
      </div>
      <div className="mt-2">
        <Collapsible
          title="Steps in this flow"
          count={flow.length}
          defaultOpen={flow.length <= 10}
        >
          <ul className="space-y-0.5">
            {flow.map((t) => {
              const tl = lifecycleOf(t, byId);
              const isSelf = t.id === self.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={isSelf ? undefined : () => onOpen(t.id)}
                    className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors ${
                      isSelf ? "bg-accent/[0.08]" : "hover:bg-bg-1"
                    }`}
                    title={isSelf ? "This task" : `Open “${t.title}”`}
                  >
                    <StatusTick life={tl} />
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] ${
                        tl === "done"
                          ? "text-text-4 line-through decoration-text-5/40"
                          : "text-text-2 group-hover:text-text-1"
                      }`}
                    >
                      {t.title}
                    </span>
                    {isSelf ? (
                      <span className="shrink-0 text-[10px] font-medium text-accent">
                        this one
                      </span>
                    ) : (
                      <ChevronRight
                        size={12}
                        className="shrink-0 text-text-5 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Collapsible>
      </div>
    </div>
  );
}

/** A real status tick for a flow step: a green check when done, an amber
 *  spinner while an agent's on it, a hollow ring while it's still ahead. */
function StatusTick({ life }: { life: Lifecycle }) {
  if (life === "done") {
    return (
      <Check size={13} className="shrink-0" style={{ color: TICK_COLOR.done }} />
    );
  }
  if (life === "working") {
    return (
      <Loader2
        size={12}
        className="shrink-0 animate-spin"
        style={{ color: TICK_COLOR.working }}
      />
    );
  }
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-full border-[1.5px]"
      style={{ borderColor: TICK_COLOR[life] }}
    />
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-4">
        {label}
      </div>
      {children}
    </section>
  );
}

/** A label → value pair, stacked: the label on its own line with the value on
 *  the next, full-width line. A fixed-gutter row clipped long values (a goal
 *  title ran off the drawer edge); stacking gives the value the whole width. */
function FactRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-text-5">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A titled section that folds away — used for the dependency lists, which can
 *  run long on a big board. Header shows the count; click to toggle. */
function Collapsible({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-line-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 bg-bg-1/50 px-2.5 py-1.5 text-left transition-colors hover:bg-bg-1"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-text-5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-[11.5px] font-medium text-text-2">{title}</span>
        <span className="rounded-full bg-bg-2 px-1.5 text-[10px] font-medium text-text-4">
          {count}
        </span>
      </button>
      {open ? <div className="px-1.5 py-1.5">{children}</div> : null}
    </div>
  );
}

/** The related tasks themselves — each a clickable row that jumps to its
 *  detail, with its own status dot and the plain-language reason it's wired. */
function DepList({
  self,
  tasks,
  byId,
  onOpen,
}: {
  self: LoopTask;
  tasks: LoopTask[];
  byId: Map<string, LoopTask>;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {tasks.map((t) => {
        const tl = lifecycleOf(t, byId);
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onOpen(t.id)}
              className="group w-full rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-bg-1"
              title={`Open “${t.title}”`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: CREW_ACCENT[tl] }}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-2 group-hover:text-text-1">
                  {t.title}
                </span>
                <ChevronRight
                  size={12}
                  className="shrink-0 text-text-5 opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
              <div className="mt-0.5 flex items-start gap-1 pl-[15px] text-[10.5px] leading-snug text-text-5">
                <CornerDownRight size={10} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{connectionReason(self, t)}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
