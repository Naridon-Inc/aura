// Crew · Task detail — click any task (in the graph, a lane, or the activity
// feed) and its whole story opens in the sheet over the work. A "back" row
// returns to the list; Esc does the same.
//
// It is the task detail the Tasks place draws, in a narrow column: the subject
// with its muted status line, the properties as label/value rows, small
// section headings, and dependency rows that open the task they name.
//   • the spec + "done when" render as real MARKDOWN (headings, lists, code),
//   • who's on it / where it sits (goal, objective, sprint) are property rows,
//   • "Waiting on" / "Unblocks" fold away on a big board, and their rows are
//     the real tasks — click one to jump straight to its detail,
//   • and a plain-language line under each row explains WHY the arrow exists,
//     so the lines on the board stop being a mystery.
//
// Everything resolves from the same `allTasks` the shell already holds — no new
// fetch. Failed tasks get a Retry; in-flight ones get a Release (hand it back to
// the queue) so a wedged run is never stuck.

import { useEffect, useMemo, type ReactNode } from "react";
import { ArrowLeft, Check, CircleDashed, Play, RotateCcw, Send, X } from "lucide-react";

import type { LoopTask } from "../../../lib/api";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../ui/accordion";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Progress } from "../../ui/progress";
import {
  TaskDependencyLinks,
  TaskDetailHeader,
  TaskDetailMeta,
  TaskDetailNote,
  TaskDetailSection,
  type TaskDependencyItem,
} from "../../ui/tasks-detail";
import { TaskProperty, TaskPropertyEmpty, TaskPropertyList } from "../../ui/tasks-properties";
import { TaskStatusBadge } from "../../ui/tasks-status";
import { Timeline, type TimelineEntry } from "../../ui/timeline";
import { WorkspaceStageIcon, type WorkspaceStage } from "../../ui/workspace-preview-card";
import { TaskMarkdown } from "../../tasks/TaskMarkdown";
import { bestProof, proofForCommit, type CrewProof } from "./crewProof";
import {
  AgentBit,
  AssigneeBit,
  CommitChip,
  ProofPill,
  relativeTime,
} from "./crewShared";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { percent } from "../../../lib/percent";
import "../../ui/tasks-detail-sections.css";
import "../../ui/crew-detail.css";

type Lifecycle = "ready" | "working" | "blocked" | "paused" | "done" | "failed";

/** Plain-language lifecycle → the task status badge: the board's stage glyph
 *  and a word. Not started (ready, waiting, paused) is the open ring, an
 *  agent at work is the half ring, done is the tick, and a run that stopped is
 *  the cross in red.
 *
 *  The words are the Board's lane names, not a second set. This drawer opens
 *  out of a lane, so a card lifted from "Ready" that lands under a badge saying
 *  "Ready to start" — or lifted from "Waiting" under "Waiting on earlier work"
 *  — is asking the reader to decide whether those are the same state. They
 *  are. The lane's caption is where the longer sentence lives. */
const LIFECYCLE_STATE: Record<
  Lifecycle,
  { stage: WorkspaceStage; label: string; color?: string }
> = {
  ready: { stage: "backlog", label: "Ready" },
  working: { stage: "in-progress", label: "Building" },
  blocked: { stage: "backlog", label: "Waiting" },
  paused: { stage: "backlog", label: "Paused" },
  done: { stage: "done", label: "Done" },
  failed: { stage: "canceled", label: "Couldn’t finish", color: "var(--ui-red)" },
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
  const state = LIFECYCLE_STATE[life];
  const priority = (task.priority ?? "").trim();
  const source =
    task.external_id &&
    (task.external_source === "jira" || task.external_source === "beads")
      ? `${task.external_source === "jira" ? "Jira" : "Beads"} ${task.external_id}`
      : null;
  const assignee = task.assignee?.trim() ?? "";

  return (
    <div className="ui-crew-detail">
      {/* Back to the list — the master→detail return path, in the same column. */}
      <div className="ui-crew-detail-back">
        <Button variant="ghost" size="sm" onClick={onClose} title="Back to the worklist (Esc)">
          <ArrowLeft />
          All tasks
        </Button>
      </div>

      <div className="ui-crew-detail-scroll">
        <article className="ui-task-details ui-crew-detail-main">
          {/* The heading IS the task; the line under it says where it stands. */}
          <TaskDetailHeader>
            <h2 className="ui-crew-detail-title">{task.title}</h2>
          </TaskDetailHeader>
          <TaskDetailMeta
            parts={[
              <TaskStatusBadge stage={state.stage} label={state.label} color={state.color} />,
              priority && priority !== "low"
                ? `${priority[0]!.toUpperCase()}${priority.slice(1)} priority`
                : null,
              source,
              task.updated_at ? `Updated ${relativeTime(task.updated_at)}` : null,
            ]}
          />

          {/* Who & where — property rows, not a text run. */}
          <TaskDetailSection>
            <TaskPropertyList>
              <TaskProperty label="Agent">
                <span className="ui-tasks-crew-agent">
                  <AgentBit agentKind={task.agent_kind} size={16} />
                  {agentLabel}
                </span>
              </TaskProperty>
              <TaskProperty label="Assignee">
                {assignee ? (
                  <span className="ui-tasks-crew-agent">
                    <AssigneeBit name={assignee} size={16} />
                    {assignee}
                  </span>
                ) : (
                  <TaskPropertyEmpty>Nobody yet</TaskPropertyEmpty>
                )}
              </TaskProperty>
              {/* Every one of these is a place this task sits in, not a state
                  it is in — so each is a plain row, and a long goal wraps
                  rather than running off the sheet's edge. */}
              {place.goal ? (
                <TaskProperty label="Goal">
                  <span className="ui-crew-detail-value">{place.goal}</span>
                </TaskProperty>
              ) : null}
              {place.objective ? (
                <TaskProperty label="Objective">
                  <span className="ui-crew-detail-value">{place.objective}</span>
                </TaskProperty>
              ) : null}
              {place.wave ? <TaskProperty label="Wave">{place.wave}</TaskProperty> : null}
              {place.sprint ? <TaskProperty label="Sprint">{place.sprint}</TaskProperty> : null}
              {place.prd ? (
                <TaskProperty label="Spec">{place.prd.toUpperCase()}</TaskProperty>
              ) : null}
            </TaskPropertyList>
          </TaskDetailSection>

          {/* Progress — the context that used to be missing the moment a task
              showed "running": where it is in its own life (a step timeline),
              how far its whole goal-flow has come, and every step in that flow
              with its status. Shown for everything that isn't already finished
              (done has its own Result block below). */}
          {life !== "done" ? (
            <TaskDetailSection title="Progress">
              <Timeline entries={stepsOf(task, life)} />
              {flow.length > 1 ? (
                <FlowProgress
                  self={task}
                  flow={flow}
                  done={flowDone}
                  byId={byId}
                  onOpen={onOpen}
                />
              ) : null}
            </TaskDetailSection>
          ) : null}

          {/* The spec — what this task actually asks for, as markdown. */}
          {task.input?.trim() ? (
            <TaskDetailSection title="What this does">
              <TaskMarkdown source={task.input.trim()} />
            </TaskDetailSection>
          ) : null}

          {/* Acceptance criteria — how it knows it's done, as markdown. */}
          {task.acceptance_criteria?.trim() ? (
            <TaskDetailSection title="Done when">
              <TaskMarkdown source={task.acceptance_criteria.trim()} />
            </TaskDetailSection>
          ) : null}

          {/* Connections — the WHY behind the arrows on the board. */}
          {waitingOn.length > 0 || unblocks.length > 0 ? (
            <TaskDetailSection title="Connections">
              <TaskDetailNote>
                Arrows on the board show the order of work. This task can’t
                start until everything it’s <b>waiting on</b> is done; finishing
                it frees the tasks it <b>unblocks</b>.
              </TaskDetailNote>
              <Accordion
                type="multiple"
                className="ui-crew-detail-folds"
                defaultValue={[
                  ...(waitingOn.length <= 8 ? ["waiting"] : []),
                  ...(unblocks.length <= 8 ? ["unblocks"] : []),
                ]}
              >
                {waitingOn.length > 0 ? (
                  <Fold value="waiting" title="Waiting on" count={waitingOn.length}>
                    <TaskDependencyLinks
                      items={dependencyItems(task, waitingOn, byId)}
                      onOpen={onOpen}
                    />
                  </Fold>
                ) : null}
                {unblocks.length > 0 ? (
                  <Fold value="unblocks" title="Unblocks" count={unblocks.length}>
                    <TaskDependencyLinks
                      items={dependencyItems(task, unblocks, byId)}
                      onOpen={onOpen}
                    />
                  </Fold>
                ) : null}
              </Accordion>
            </TaskDetailSection>
          ) : null}

          {/* Done → the commit + the proof + the files it touched. */}
          {life === "done" ? (
            <TaskDetailSection title="Result">
              <TaskPropertyList>
                {task.commit_sha ? (
                  <TaskProperty label="Commit">
                    <CommitChip sha={task.commit_sha} />
                  </TaskProperty>
                ) : null}
                <TaskProperty label="Checks">
                  {best ? (
                    // Proven / almost / not-built — the ledger recorded a check
                    // for this commit.
                    <ProofPill proof={best} />
                  ) : place.goal ? (
                    // It DOES belong to a goal — Aura just hasn't recorded a
                    // check for this commit yet (the goal needs a checkable
                    // "done when", or the auto-prove hook hasn't run). Say that
                    // honestly instead of the old "not checked against a goal",
                    // which read as if the task had no goal at all.
                    <Badge
                      variant="outline"
                      className="ui-crew-badge"
                      data-tone="neutral"
                      title="This task is part of a goal, but Aura hasn't confirmed it's met for this commit yet."
                    >
                      <CircleDashed />
                      Not confirmed yet
                    </Badge>
                  ) : (
                    <TaskPropertyEmpty>No goal set yet</TaskPropertyEmpty>
                  )}
                </TaskProperty>
              </TaskPropertyList>
              {best?.goalText ? (
                <TaskDetailNote>Goal: {best.goalText}</TaskDetailNote>
              ) : place.goal ? (
                <TaskDetailNote>Goal: {place.goal}</TaskDetailNote>
              ) : null}
              {best && best.files.length > 0 ? (
                <ul className="ui-crew-detail-files">
                  {best.files.slice(0, 8).map((f) => (
                    <li key={f} title={f}>
                      {f}
                    </li>
                  ))}
                  {best.files.length > 8 ? (
                    <li className="ui-crew-detail-more">+{best.files.length - 8} more</li>
                  ) : null}
                </ul>
              ) : null}
            </TaskDetailSection>
          ) : null}

          {/* Failed → the error. */}
          {life === "failed" && (task.error_message ?? "").trim() ? (
            <TaskDetailSection title="What went wrong">
              <div className="ui-tasks-crew-failed">
                <p role="alert">{task.error_message?.trim()}</p>
              </div>
            </TaskDetailSection>
          ) : null}
        </article>
      </div>

      {/* Footer verbs — only what makes sense for this lifecycle. Each re-arms
          the single node into the ready set (the same primitive Retry/Release
          use); goal-wide pause/resume still lives on the Control tab. */}
      {life === "failed" || life === "working" || life === "paused" ? (
        <div className="ui-crew-detail-foot">
          {life === "failed" ? (
            <Button
              variant="default"
              size="sm"
              onClick={() =>
                onRetry
                  ? onRetry(task.id)
                  : onSetStatus(task.id, "submitted")
              }
              title="Re-queue this task and run it again. An agent picks it up right away (or tells you what it's still waiting on)"
            >
              <RotateCcw />
              Retry
            </Button>
          ) : life === "paused" ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => onSetStatus(task.id, "submitted")}
              title="Un-pause this task. Put it back in the ready queue"
            >
              <Play />
              Resume
            </Button>
          ) : (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => onSetStatus(task.id, "submitted")}
              title="Hand this back to the queue so another pass can pick it up"
            >
              <Send />
              Release
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** This task's own life as the library timeline — the missing answer to
 *  "what's happened and what's next" the instant a card flips to running.
 *  Every step is real: when it was added, when an agent picked it up, and
 *  where it is right now. No invented progress. Behind us wears a tick, the
 *  step happening now is the filled marker, what's still ahead is muted, and
 *  a stopped run wears a cross. */
function stepsOf(task: LoopTask, life: Lifecycle): TimelineEntry[] {
  const done = <Check data-mark="done" />;
  const steps: TimelineEntry[] = [
    {
      id: "added",
      title: "Added to the queue",
      detail: task.created_at ? relativeTime(task.created_at) : undefined,
      marker: done,
    },
  ];
  if (life === "working") {
    steps.push({
      id: "picked",
      title: "An agent picked it up",
      detail: task.updated_at ? relativeTime(task.updated_at) : undefined,
      marker: done,
    });
    steps.push({ id: "now", title: "Working on it now", tone: "active" });
  } else if (life === "ready") {
    steps.push({ id: "now", title: "Ready. The crew picks it up next", tone: "active" });
  } else if (life === "blocked") {
    steps.push({ id: "next", title: "Waiting on earlier work to finish", tone: "incomplete" });
  } else if (life === "paused") {
    steps.push({
      id: "next",
      title: "Paused. Held out of the queue, resumable",
      tone: "incomplete",
    });
  } else if (life === "failed") {
    steps.push({
      id: "stopped",
      title: "Run stopped. Needs a retry",
      detail: task.updated_at ? relativeTime(task.updated_at) : undefined,
      marker: <X data-mark="failed" />,
    });
  }
  return steps;
}

/** Related tasks as dependency rows: the stage glyph says whether each one is
 *  cleared, and the line under the name says why the arrow exists. */
function dependencyItems(
  self: LoopTask,
  tasks: LoopTask[],
  byId: Map<string, LoopTask>,
): TaskDependencyItem[] {
  return tasks.map((t) => ({
    id: t.id,
    label: t.title,
    icon: <WorkspaceStageIcon stage={LIFECYCLE_STATE[lifecycleOf(t, byId)].stage} />,
    detail: connectionReason(self, t),
  }));
}

/** The whole goal-flow's progress, with this task in it — answers "how much of
 *  the work is done, what's left" without leaving the detail. A bar for the
 *  count, then a foldable list of every step with its status glyph; the
 *  current task is marked and the rest jump on click. */
function FlowProgress({
  self,
  flow,
  done,
  byId,
  onOpen,
}: {
  self: LoopTask;
  flow: LoopTask[];
  done: number;
  byId: Map<string, LoopTask>;
  onOpen: (id: string) => void;
}) {
  // No heading of its own beyond the count: "Where it sits" already names the
  // goal sixty pixels higher. What is left is the one thing neither says —
  // how far along the flow is.
  const items: TaskDependencyItem[] = flow.map((t) => ({
    id: t.id,
    label: t.title,
    icon: <WorkspaceStageIcon stage={LIFECYCLE_STATE[lifecycleOf(t, byId)].stage} />,
    hint: t.id === self.id ? "This one" : undefined,
  }));
  return (
    <div className="ui-tasks-crew-deps">
      <h5>How far this flow has come</h5>
      <div className="ui-tasks-subtasks-progress">
        <Progress value={percent(done, flow.length)} aria-label="How far this flow has come" />
        <span>
          {done} of {flow.length} done
        </span>
      </div>
      <Accordion
        type="multiple"
        className="ui-crew-detail-folds"
        defaultValue={flow.length <= 10 ? ["steps"] : []}
      >
        <Fold value="steps" title="Steps in this flow" count={flow.length}>
          <TaskDependencyLinks
            items={items}
            onOpen={(id) => {
              if (id !== self.id) onOpen(id);
            }}
          />
        </Fold>
      </Accordion>
    </div>
  );
}

/** A titled group that folds away — the dependency lists and the flow's
 *  steps, which can run long on a big board. The heading carries the count. */
function Fold({
  value,
  title,
  count,
  children,
}: {
  value: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger>
        <span>
          {title}
          <span className="ui-tasks-detail-count">{count}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>{children}</AccordionContent>
    </AccordionItem>
  );
}
