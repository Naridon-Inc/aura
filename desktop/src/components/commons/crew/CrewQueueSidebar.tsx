// Crew · Queue — the SIDEBAR. The canvas beside it draws the work as a graph;
// this column is the honest worklist that answers "what's running, what's next".
// Crew is an autonomous loop: hand it a pile of tasks, it works them on its own.
// The sidebar is grouped by STATUS — the same lifecycle the rest of the app
// speaks — and reads top-to-bottom like a list, never a tree:
//
//   0. Where it stands — a one-glance status bar across the whole queue.
//   1. In progress — anything an agent is on this second (usually empty).
//   2. Up next     — the tasks that run next, in order; the rest collapse behind
//                    "all ready" as one flat, run-ordered list.
//   3. Blocked     — waiting on something else to finish first.
//   4. Paused      — held back from the ready set, resumable.
//   5. Recently done — a quiet tail; full proof lives in Activity.
//
// Grouped by status, NOT priority: priority only sets run order inside the ready
// pile (and a faint per-row dot) — it's never the organizing axis.
// Every row is a button → selects the task (highlighting its node on the canvas
// and opening the detail drawer). Same unified `ready_view` as the canvas, the
// runner, and chat's `/loop`; no new data, no mock state.

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleSlash,
  Loader2,
  PauseCircle,
  RefreshCw,
} from "lucide-react";

import type { LoopTask, ReadyViewDto } from "../../../lib/api";
import { Button } from "../../ui/button";
import { crewPickOrder, PRIORITY_META, priorityKey } from "./crewQueue";
import { AgentBit, CommitChip, CREW_ACCENT, WorkingLine } from "./crewShared";

// The status lifecycle, in the order it reads top-to-bottom. Drives both the
// one-glance overview bar and the section ordering. Colours are the shared crew
// accent palette (amber = an agent's on it, arctic-blue = ready, green = done,
// muted = waiting/parked) so status reads the same here as everywhere else.
const STATUS_SHAPE: Array<{
  key: "working" | "ready" | "blocked" | "paused" | "done";
  label: string;
  color: string;
}> = [
  { key: "working", label: "In progress", color: CREW_ACCENT.working },
  { key: "ready", label: "Ready", color: CREW_ACCENT.ready },
  { key: "blocked", label: "Blocked", color: CREW_ACCENT.blocked },
  { key: "paused", label: "Paused", color: "var(--color-text-4)" },
  { key: "done", label: "Done", color: CREW_ACCENT.done },
];

// How many "next up" rows to show before the rest collapse into the grouped
// disclosure. Enough to plan around, few enough to scan in a breath.
const NEXT_UP_CAP = 8;
// Hard cap per priority group inside the expanded "all ready" list, so even a
// thousand-task pile never floods the DOM. The crew works them all regardless;
// the UI just stops enumerating past this and says how many more there are.
const GROUP_CAP = 40;

export function CrewQueueSidebar({
  view,
  selectedId,
  onSelect,
  onSync,
  syncing,
}: {
  view: ReadyViewDto;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Pull the task board into the queue — pinned at the foot of the list,
   *  where "where does more work come from?" naturally gets asked. */
  onSync?: () => void;
  syncing?: boolean;
}) {
  const pickOrder = useMemo(() => crewPickOrder(view.ready), [view.ready]);
  const nextUp = pickOrder.slice(0, NEXT_UP_CAP);
  const rest = pickOrder.length - nextUp.length;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3.5 pb-2 pt-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-4">
          The plan
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-text-5">
          Worked top to bottom. The board beside it is the same work, drawn.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-6">
        {/* 0 · Where it stands — the whole queue's status shape in one bar. */}
        <StatusOverview view={view} />

        {/* 1 · In progress — only when an agent is actually on something. */}
        {view.working.length > 0 ? (
          <Section
            status="working"
            title="In progress"
            hint="An agent is on these."
            count={view.working.length}
          >
            <div className="space-y-1.5">
              {view.working.map((t) => (
                <QueueRow
                  key={t.id}
                  task={t}
                  status="working"
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {/* 2 · Up next — the ready pile in run order, honest about its scale. */}
        {view.ready.length > 0 ? (
          <Section
            status="ready"
            title="Up next"
            hint="In the order they'll run."
            count={view.ready.length}
          >
            <div className="space-y-1.5">
              {nextUp.map((t, i) => (
                <QueueRow
                  key={t.id}
                  task={t}
                  status="ready"
                  order={i + 1}
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
            {rest > 0 ? (
              <AllReadyDisclosure
                ready={view.ready}
                shownIds={new Set(nextUp.map((t) => t.id))}
                rest={rest}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ) : null}
          </Section>
        ) : null}

        {/* 3 · Blocked — waiting on something else. */}
        {view.blocked.length > 0 ? (
          <Section
            status="blocked"
            title="Blocked"
            hint="Waiting on another task."
            count={view.blocked.length}
          >
            <div className="space-y-1.5">
              {view.blocked.map((b) => (
                <QueueRow
                  key={b.task.id}
                  task={b.task}
                  status="blocked"
                  waitingOn={b.unmet.length}
                  selected={b.task.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {/* 4 · Paused — held out of the ready set, resumable. */}
        {view.paused.length > 0 ? (
          <Section
            status="paused"
            title="Paused"
            hint="Held back, resumable."
            count={view.paused.length}
          >
            <div className="space-y-1.5">
              {view.paused.map((t) => (
                <QueueRow
                  key={t.id}
                  task={t}
                  status="paused"
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {/* 5 · Recently done — a quiet tail so the queue has a sense of
            progress; the full proof-carrying feed lives in Activity. */}
        {view.done.length > 0 ? (
          <Section
            status="done"
            title="Recently done"
            hint="Proof's in Activity."
            count={view.done.length}
          >
            <div className="space-y-1.5">
              {view.done.slice(0, 6).map((t) => (
                <QueueRow
                  key={t.id}
                  task={t}
                  status="done"
                  selected={t.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Section>
        ) : null}
      </div>

      {/* Foot of the list — where more work comes from. Pulls every board task
          (including Jira / Beads imports) into the queue and wires their
          "waiting on" links. */}
      {onSync ? (
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
              <Loader2 size={13} className="animate-spin" />
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

/** The status glyph that heads each section — same vocabulary the rest of the
 *  app (and Conductor) speaks: a spinner for live work, a check for done, an
 *  outline for queued, a slash/pause for held. Colour-matched to STATUS_SHAPE. */
function StatusGlyph({
  status,
}: {
  status: "working" | "ready" | "blocked" | "paused" | "done";
}) {
  const c = STATUS_SHAPE.find((s) => s.key === status)?.color;
  const common = { size: 13, style: { color: c }, strokeWidth: 2.25 } as const;
  switch (status) {
    case "working":
      return <Loader2 {...common} className="animate-spin" />;
    case "ready":
      return <Circle {...common} />;
    case "blocked":
      return <CircleSlash {...common} />;
    case "paused":
      return <PauseCircle {...common} />;
    case "done":
      return <CheckCircle2 {...common} />;
  }
}

/** A labelled block: a status glyph + title + count + one plain-language line of
 *  why it's here. The glyph makes the status legible at a glance, list or not. */
function Section({
  status,
  title,
  hint,
  count,
  children,
}: {
  status: "working" | "ready" | "blocked" | "paused" | "done";
  title: string;
  hint: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <StatusGlyph status={status} />
        <span className="text-[11.5px] font-semibold text-text-1">{title}</span>
        {count !== undefined ? (
          <span className="text-[11px] tabular-nums text-text-4">{count}</span>
        ) : null}
        <span className="ml-0.5 truncate text-[10.5px] text-text-5">{hint}</span>
      </div>
      {children}
    </section>
  );
}

/** Where the whole queue stands, in one glance: a stacked bar of STATUS colours
 *  + a legend (in progress / ready / blocked / paused / done). Status-driven —
 *  it answers "what's the shape of my work right now", never "what's urgent". */
function StatusOverview({ view }: { view: ReadyViewDto }) {
  const counts: Record<string, number> = {
    working: view.counts?.working ?? view.working.length,
    ready: view.counts?.ready ?? view.ready.length,
    blocked: view.counts?.blocked ?? view.blocked.length,
    paused: view.counts?.paused ?? view.paused.length,
    done: view.counts?.done ?? view.done.length,
  };
  const segments = STATUS_SHAPE.filter((s) => counts[s.key] > 0);
  const total = segments.reduce((n, s) => n + counts[s.key], 0);
  if (total === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-2">
        {segments.map((s) => (
          <div
            key={s.key}
            style={{
              width: `${(counts[s.key] / total) * 100}%`,
              background: s.color,
            }}
            title={`${counts[s.key]} ${s.label.toLowerCase()}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {segments.map((s) => (
          <span
            key={s.key}
            className="inline-flex items-center gap-1 text-[10.5px] text-text-4"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: s.color }}
            />
            <span className="tabular-nums text-text-2">{counts[s.key]}</span>
            {s.label.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "Show all N ready" — collapsed by default so the pile never floods the
 *  column. Opt in and you get the rest of the ready set as ONE flat list, in the
 *  exact order it'll run (priority sorts that order, but it isn't a heading) —
 *  capped so even a thousand-task backlog stays scannable. */
function AllReadyDisclosure({
  ready,
  shownIds,
  rest,
  selectedId,
  onSelect,
}: {
  ready: LoopTask[];
  shownIds: Set<string>;
  rest: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The remaining ready tasks, still in run order, minus the ones already shown
  // up top. One flat list — status is the grouping, run order is the sort.
  const remaining = useMemo(
    () => crewPickOrder(ready).filter((t) => !shownIds.has(t.id)),
    [ready, shownIds],
  );
  const capped = remaining.slice(0, GROUP_CAP);
  const more = remaining.length - capped.length;

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-text-3 transition-colors hover:text-text-1"
      >
        <ChevronRight
          size={12}
          className="transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        {open ? "Hide the rest" : `Show all ${ready.length}`}
      </button>

      {open ? (
        <div className="mt-2.5 space-y-1.5">
          {capped.map((t, i) => (
            <QueueRow
              key={t.id}
              task={t}
              status="ready"
              order={NEXT_UP_CAP + i + 1}
              selected={t.id === selectedId}
              onSelect={onSelect}
            />
          ))}
          {more > 0 ? (
            <p className="mt-1.5 px-0.5 text-[10.5px] text-text-5">
              + {more} more, worked in order.
            </p>
          ) : null}
          <p className="px-0.5 pt-0.5 text-[10.5px] text-text-5">
            {rest} of {ready.length} run after the {NEXT_UP_CAP} above.
          </p>
        </div>
      ) : null}
    </div>
  );
}

type RowStatus = "ready" | "working" | "blocked" | "paused" | "done";

/** One task as a compact row — the single card shape the whole sidebar uses.
 *  Status is carried by the section it sits in (Working / Up next / Blocked /
 *  Done), so the row itself stays clean: an optional order badge shows pick
 *  position, a small priority dot reads urgency. No status colour bars. */
function QueueRow({
  task,
  status,
  order,
  waitingOn,
  selected,
  onSelect,
}: {
  task: LoopTask;
  status: RowStatus;
  order?: number;
  waitingOn?: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const pk = priorityKey(task.priority);
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className="flex w-full items-center gap-2 rounded-lg border bg-bg-0 shadow-[var(--shadow-card)] px-2.5 py-2 text-left transition-colors hover:bg-bg-2"
      style={{
        borderColor: selected ? "var(--color-accent)" : "var(--color-line-soft)",
        boxShadow: selected ? "0 0 0 1px var(--color-accent)" : undefined,
      }}
    >
      {order !== undefined ? (
        <span
          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-bg-2 text-[9.5px] font-semibold tabular-nums text-text-3"
          title={`Runs #${order}`}
        >
          {order}
        </span>
      ) : null}
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
        ) : status === "blocked" && waitingOn ? (
          <div className="mt-0.5 text-[10px] text-text-4">
            waiting on {waitingOn} {waitingOn === 1 ? "task" : "tasks"}
          </div>
        ) : status === "paused" ? (
          <div className="mt-0.5 text-[10px] text-text-4">paused — resumable</div>
        ) : status === "done" && task.commit_sha ? (
          <div className="mt-0.5">
            <CommitChip sha={task.commit_sha} />
          </div>
        ) : null}
      </div>
      {/* Priority as a small coloured dot — quiet, but lets you read the pile's
          urgency without a chip per row. Low = no dot. */}
      {pk !== "low" ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: PRIORITY_META[pk].color }}
          title={`${PRIORITY_META[pk].label} priority`}
        />
      ) : null}
    </button>
  );
}
