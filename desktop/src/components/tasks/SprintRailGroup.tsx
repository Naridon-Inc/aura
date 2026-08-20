// The rail's Sprints group — the list, and the two things you can do to one.
//
// Sprints used to have a whole lens: a page with a burndown chart, a capacity
// rollup, a velocity sparkline, a staleness heuristic and a pull-into-sprint
// drawer, reached from a cell on the header strip. That page is gone — a
// sprint is a slice of the backlog, and List and Board already draw a slice of
// the backlog once the rail picks one.
//
// What could not go with it is the sprint LIFECYCLE. You start a sprint and
// later you complete it, and both doors lived on that page and nowhere else:
// deleting it would have left the rail listing an object the product had no
// way to make and no way to finish. Exactly the defect the Workstreams group
// one row down documents — a store, a command and a picker all shipped, with
// nothing anywhere that called the writer.
//
// So they live here, on the object they act on, in the rail's own vocabulary:
// the group's `+` starts one (the same affordance Workstreams already wears),
// and a sprint's own row carries "make current" and "complete" on hover. No
// new controls, no new page; the acts moved to the list of the things they
// act on.

import { useMemo, useState } from "react";
import { Check, CircleDot, Plus } from "lucide-react";

import { api, type Cycle, type SprintInput, type Task } from "../../lib/api";
import {
  carryTargets,
  cycleAsSprint,
  isCompleted,
  planningBacklog,
  sprintScope,
} from "../../lib/sprintScope";
import { PlaceRailGroup, PlaceRailRow } from "../places/PlaceRail";
import { Button } from "../ui/button";
import { CreateSprintWizard } from "./CreateSprintWizard";
import { CARRY_TO_BACKLOG, CloseSprintPanel } from "./CloseSprintPanel";

type Props = {
  /** The one project these sprints belong to, or null under All projects —
   *  two projects can each be running their own "Sprint 3", so there is no
   *  single catalog to list or write to. */
  repoRoot: string | null;
  cycles: Cycle[];
  /** Every task in scope. Drives each row's count and, at close, what the
   *  sprint delivered and what it carries. */
  tasks: Task[];
  /** The sprint the rail is narrowed to, if any. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Re-read the rail after a write. */
  onChanged: () => void | Promise<void>;
};

export function SprintRailGroup({
  repoRoot,
  cycles,
  tasks,
  selectedId,
  onSelect,
  onChanged,
}: Props) {
  const [creating, setCreating] = useState(false);
  /** The sprint whose Complete panel is open. */
  const [closing, setClosing] = useState<Cycle | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of tasks) {
      if (t.cycle_id) out.set(t.cycle_id, (out.get(t.cycle_id) ?? 0) + 1);
    }
    return out;
  }, [tasks]);

  /** The one measurement of the sprint being closed — every figure the
   *  Complete panel prints comes from this, so its three numbers can never
   *  be in different units. */
  const closingScope = useMemo(
    () => (closing ? sprintScope(tasks, closing.id) : null),
    [closing, tasks],
  );

  async function createSprint(input: SprintInput, scopeTaskIds: string[]) {
    if (!repoRoot) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await api.sprintsCreate(repoRoot, input);
      // The wizard's Scope step is a plan, not a filter: each chosen task is
      // bound to the new sprint through the dedicated assign so the cycle's
      // membership mirror stays in step with `Task.cycle_id`.
      for (const taskId of scopeTaskIds) {
        await api.tasksCycleAssign(repoRoot, next.id, taskId);
      }
      setCreating(false);
      await onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Make this the sprint the team is on. Only one is current at a time —
   *  the backend enforces it, and re-reading afterwards is what keeps the
   *  rail from having its own opinion about which. */
  async function makeCurrent(cycle: Cycle) {
    if (!repoRoot) return;
    setBusy(true);
    setErr(null);
    try {
      const s = cycleAsSprint(cycle);
      await api.sprintsUpdate(repoRoot, {
        id: s.id,
        name: s.name,
        start: s.start,
        end: s.end,
        goal: s.goal,
        active: true,
      });
      await onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Complete the sprint: move everything unfinished to the chosen home (a
   *  sprint that is still open, or back to the backlog), freeze what was
   *  delivered as the sprint's velocity, and mark it done. Finished items
   *  keep their sprint, so the closed sprint still reads its own scope. */
  async function completeSprint(target: string) {
    // `closingScope` rather than a fresh measurement: the velocity we freeze
    // has to be the number the panel showed the reader, not one taken again
    // after they read it.
    if (!repoRoot || !closing || !closingScope) return;
    setBusy(true);
    setErr(null);
    try {
      const carried = tasks.filter(
        (t) => t.cycle_id === closing.id && !t.is_epic && t.status !== "done",
      );
      for (const t of carried) {
        if (target === CARRY_TO_BACKLOG) {
          await api.tasksCycleUnassign(repoRoot, closing.id, t.id);
        } else {
          await api.tasksCycleAssign(repoRoot, target, t.id);
        }
      }
      await api.tasksCycleClose(repoRoot, closing.id, closingScope.velocity);
      setClosing(null);
      await onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* "Cycles" in storage (`task_cycles.json`), but every surface a reader
          can see calls this a sprint. One object, one word. */}
      <PlaceRailGroup
        title="Sprints"
        count={cycles.length}
        empty={
          repoRoot
            ? "No sprints yet. Start one with the + above to work in fixed stretches."
            : "Sprints belong to one project. Pick a project to see them."
        }
        actions={
          repoRoot ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCreating(true)}
              title="Start a sprint"
              aria-label="Start a sprint"
              className="text-text-4 hover:text-text-1"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null
        }
      >
        {cycles.map((c) => {
          const done = isCompleted(c);
          return (
            <PlaceRailRow
              key={c.id}
              label={c.name}
              count={counts.get(c.id) ?? 0}
              title={
                done
                  ? `${c.name}. Completed`
                  : c.status === "active"
                    ? `${c.name}. The sprint you're in`
                    : c.name
              }
              glyph={
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.status === "active" ? "bg-amber" : "bg-text-5"
                  }`}
                  aria-hidden
                />
              }
              active={selectedId === c.id}
              onClick={() => onSelect(selectedId === c.id ? null : c.id)}
              actions={
                repoRoot && !done ? (
                  <>
                    {c.status !== "active" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => void makeCurrent(c)}
                        title="Make this the sprint you're in"
                        aria-label="Make this the sprint you're in"
                        className="bg-bg-2 text-text-4 hover:text-text-1"
                      >
                        <CircleDot
                          className="h-3.5 w-3.5"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => setClosing(c)}
                      title="Complete this sprint"
                      aria-label="Complete this sprint"
                      className="bg-bg-2 text-text-4 hover:text-text-1"
                    >
                      <Check
                        className="h-3.5 w-3.5"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    </Button>
                  </>
                ) : null
              }
            />
          );
        })}
        {err && <div className="px-2 pt-1 text-2xs text-red">{err}</div>}
      </PlaceRailGroup>

      {creating && repoRoot && (
        <CreateSprintWizard
          onCancel={() => setCreating(false)}
          onSubmit={createSprint}
          backlog={planningBacklog(tasks)}
        />
      )}

      {closing && closingScope && (
        <CloseSprintPanel
          sprint={cycleAsSprint(closing)}
          doneCount={closingScope.doneCount}
          donePoints={closingScope.donePoints}
          totalCount={closingScope.totalCount}
          totalPoints={closingScope.totalPoints}
          usePoints={closingScope.usePoints}
          carriedCount={closingScope.carriedCount}
          carryTargets={carryTargets(cycles, closing.id)}
          onCancel={() => setClosing(null)}
          onConfirm={completeSprint}
        />
      )}
    </>
  );
}
