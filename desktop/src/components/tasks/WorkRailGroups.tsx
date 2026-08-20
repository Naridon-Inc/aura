// The Tasks rail's other half: the goals your crews are working through, the
// crews themselves, and the runs that have already happened.
//
// These three used to live in a 340px column that Mission Control stood up
// beside its own body — so the Tasks place had a rail on the right for List and
// Board, and a DIFFERENT panel in the same place for Plan and Graph, holding a
// different set of ideas. Switching lens replaced your navigation with someone
// else's. Worse, the two disagreed about what "the work" is: the rail sliced it
// by sprint and workstream, the panel sliced it by goal and crew, and nothing on
// screen said those were slices of one board.
//
// They are. A crew node carries `board_task_id` — the card it was projected
// from — so a goal is a set of cards, exactly the way a sprint is. One rail,
// one selection, and every drawing narrows to it: the loop views by the goal's
// own nodes, List and Board by the cards those nodes came from.
//
// The per-goal Start / Pause / Resume came with them, on the goal's own row.
// That is the same bargain the Sprints group strikes one group up: the acts on
// a thing live on the list of those things, not on a page about them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Network, Pause, Play, Plus, Users } from "lucide-react";

import {
  api,
  type CrewRow,
  type ReadyViewDto,
  type RunRecord,
} from "../../lib/api";
import { fetchReadyView } from "../../lib/loopCache";
import {
  boardTaskIdsForCrew,
  boardTaskIdsForGoal,
  goalAffordances,
  goalGlyph,
  goalOfBoardTask,
  goalTail,
  humanizeGoal,
  runOutcomeLabel,
  runScopeLabel,
} from "../commons/crew/crewControl";
import {
  setTasksGoalIndex,
  setTasksSharedCrew,
  setTasksSharedGoal,
  useTasksSharedFilters,
} from "../../lib/tasksFilterStore";
import { goToWork } from "../../lib/workRoute";
import { relativeAgeAuto } from "../../lib/relativeTime";
import { PlaceRailGroup, PlaceRailRow } from "../places/PlaceRail";
import { StateGlyph } from "./StatePill";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

/** Fired by anything that changes the loop graph (a run, a pause, a sync, a
 *  freshly planned goal) so this rail re-reads without waiting on its poll.
 *  Same contract as `aura:tasks:mutated`, which the board already broadcasts. */
export const CREW_MUTATED_EVENT = "aura:crew:mutated";

export function notifyCrewMutated(): void {
  window.dispatchEvent(new Event(CREW_MUTATED_EVENT));
}

/** How many past runs the rail keeps. Enough to answer "did that land?", few
 *  enough that the group stays a footnote to the goals above it. */
const RUN_LIMIT = 8;

export function WorkRailGroups({
  repoRoot,
}: {
  /** The one project these goals belong to, or null under All projects — a
   *  loop graph is per-repo, and two projects can each be running a goal of
   *  the same name. */
  repoRoot: string | null;
}) {
  const shared = useTasksSharedFilters();
  const [view, setView] = useState<ReadyViewDto | null>(null);
  const [crews, setCrews] = useState<CrewRow[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  /** The goal slug mid-Start/Pause/Resume, so only its row spins. */
  const [acting, setActing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [crewName, setCrewName] = useState("");

  const refresh = useCallback(async () => {
    if (!repoRoot) {
      setView(null);
      setCrews([]);
      setRuns([]);
      // Under All projects there is no one graph to read, so nothing can be
      // tagged with a goal. Say so, rather than leaving the last project's
      // answer on rows that belong to seven others.
      setTasksGoalIndex({});
      return;
    }
    // Every read is independently forgiving: a project that has never run a
    // crew has no runs file and no registry, and that is a rail with fewer
    // groups in it, not an error message.
    const [v, c, r] = await Promise.all([
      fetchReadyView(repoRoot).catch(() => null),
      api.loopCrews(repoRoot).catch(() => [] as CrewRow[]),
      api.loopRuns(repoRoot, RUN_LIMIT).catch(() => [] as RunRecord[]),
    ]);
    setView(v);
    setCrews(c);
    setRuns(r);
    // The Plan view used to be where you saw which goal a task belonged to.
    // There is no Plan view now — the tag on the row says it — and this is the
    // side that holds the graph, so the join is resolved once here and every
    // drawing of a task can read it off the shared store.
    setTasksGoalIndex(v ? goalOfBoardTask(v) : {});
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
    // The same 30s cadence the rest of this rail polls on — the surfaces that
    // WRITE to the graph announce themselves below, so this only has to catch
    // sibling edits from the CLI and other agents.
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener(CREW_MUTATED_EVENT, onMutate);
    return () => window.removeEventListener(CREW_MUTATED_EVENT, onMutate);
  }, [refresh]);

  const goals = view?.goals ?? [];

  /** Pick a goal, or un-pick the one that's lit. The board cards behind it are
   *  resolved here — the rail is the side that holds the loop graph, so the
   *  board never has to read it to narrow to the same slice. */
  const selectGoal = (slug: string) => {
    if (shared.goal?.id === slug || !view) {
      setTasksSharedGoal(null);
      return;
    }
    setTasksSharedGoal({
      id: slug,
      boardTaskIds: boardTaskIdsForGoal(view, slug),
    });
  };

  const selectCrew = (id: string) => {
    if (shared.crew?.id === id || !view) {
      setTasksSharedCrew(null);
      return;
    }
    setTasksSharedCrew({ id, boardTaskIds: boardTaskIdsForCrew(view, id) });
  };

  /** One shape for all three goal verbs: spin only this row, run it, re-read,
   *  and let every other surface on the page re-read too. */
  const act = useCallback(
    async (slug: string, fn: () => Promise<unknown>) => {
      if (acting) return;
      setActing(slug);
      setErr(null);
      try {
        await fn();
        await refresh();
        notifyCrewMutated();
      } catch (e) {
        setErr(String(e));
      } finally {
        setActing(null);
      }
    },
    [acting, refresh],
  );

  async function spawnCrew() {
    const title = crewName.trim();
    if (!title || !repoRoot) return;
    setErr(null);
    try {
      const row = await api.loopCrewSpawn(repoRoot, title);
      setCrewName("");
      setNaming(false);
      await refresh();
      // A crew minted this second holds nothing, so it has no cards behind it
      // yet — an honest empty slice, which is what a new lane IS until you
      // move work onto it.
      setTasksSharedCrew({ id: row.meta.id, boardTaskIds: [] });
      notifyCrewMutated();
    } catch (e) {
      setErr(String(e));
    }
  }

  // A switcher with one option is not a switcher. "main" is implicit on every
  // project, so the group only earns its place once a second crew exists.
  const showCrews = crews.length > 1 || naming;

  const runRows = useMemo(
    () =>
      runs.map((r) => ({
        run: r,
        outcome: runOutcomeLabel(r),
        scope: runScopeLabel(r),
        color:
          r.failed > 0
            ? "var(--color-red)"
            : r.completed > 0
              ? "var(--color-accent-green)"
              : "var(--color-text-5)",
      })),
    [runs],
  );

  return (
    <>
      {/* Goals — what the crew is working through, and the one control that
          starts it. The group stands down entirely under All projects rather
          than merging several projects' goals into a list where two can share
          a name and neither can be run. */}
      <PlaceRailGroup
        title="Goals"
        count={goals.length}
        empty={
          repoRoot
            ? "No goals yet. Open the map and hand the crew a job, or ask Aura chat for one, and it works the tasks in order."
            : "Goals belong to one project. Pick a project to see them."
        }
        actions={
          // A second door to the map, beside the goals it draws. The strip in
          // the header is the first — this one is here because the map IS a
          // picture of the goals, so it's worth reaching from the group that
          // lists them rather than only from a cell two hundred pixels away.
          repoRoot ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => goToWork("graph")}
              title="Open the map. What feeds what, and where the crew is in it"
              aria-label="Open the dependency map"
              className="text-text-4 hover:text-text-1"
            >
              <Network className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null
        }
      >
        {goals.map((g) => {
          const a = goalAffordances(g);
          const tail = goalTail(g);
          const glyph = goalGlyph(g);
          const spinning = acting === g.goal;
          const busy = acting !== null && !spinning;
          return (
            <PlaceRailRow
              key={g.goal}
              label={humanizeGoal(g.goal)}
              count={g.total}
              title={`${humanizeGoal(g.goal)} · ${tail.text}`}
              glyph={<StateGlyph group={glyph.group} color={glyph.color} size={9} />}
              active={shared.goal?.id === g.goal}
              onClick={() => selectGoal(g.goal)}
              actions={
                spinning ? (
                  <span className="grid h-5 w-5 place-items-center">
                    <AsciiSpinner className="text-sm" />
                  </span>
                ) : a.canResume ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() =>
                      void act(g.goal, () =>
                        api.loopResume(repoRoot!, { goal: g.goal }),
                      )
                    }
                    title="Un-pause this goal's tasks"
                    aria-label="Un-pause this goal's tasks"
                    className="bg-bg-2 text-text-4 hover:text-text-1"
                  >
                    <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  </Button>
                ) : g.working > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() =>
                      void act(g.goal, () =>
                        api.loopPause(repoRoot!, { goal: g.goal }),
                      )
                    }
                    title="Park this goal's tasks out of the queue"
                    aria-label="Park this goal's tasks out of the queue"
                    className="bg-bg-2 text-text-4 hover:text-text-1"
                  >
                    <Pause className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  </Button>
                ) : a.canRun ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() =>
                      void act(g.goal, () =>
                        api.loopRunNative(
                          repoRoot!,
                          undefined,
                          g.goal,
                          shared.crew?.id,
                        ),
                      )
                    }
                    title="Put an agent on this goal's ready tasks"
                    aria-label="Put an agent on this goal's ready tasks"
                    className="bg-bg-2 text-text-4 hover:text-text-1"
                  >
                    <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  </Button>
                ) : null
              }
            />
          );
        })}
        {err && <div className="px-2 pt-1 text-2xs text-red">{err}</div>}
      </PlaceRailGroup>

      {/* Crews — parallel lanes of the same graph, each drained as its own
          loop, so one project can run several at once (the app's, the phone's)
          and every agent takes the next ready task in its own lane. */}
      {showCrews ? (
        <PlaceRailGroup
          title="Crews"
          count={crews.length}
          actions={
            repoRoot ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setNaming((v) => !v)}
                title="Add a crew"
                aria-label="Add a crew"
                className="text-text-4 hover:text-text-1"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
              </Button>
            ) : null
          }
        >
          {crews.map((c) => (
            <PlaceRailRow
              key={c.meta.id}
              label={c.meta.title}
              count={c.summary.total}
              title={`${c.meta.title} · ${c.summary.working} working · ${c.summary.ready} ready · ${c.summary.done} done`}
              glyph={<Users size={13} className="shrink-0 text-text-4" />}
              active={shared.crew?.id === c.meta.id}
              onClick={() => selectCrew(c.meta.id)}
            />
          ))}
          {naming && (
            <div className="px-2 pb-0.5 pt-1">
              <input
                autoFocus
                value={crewName}
                onChange={(e) => setCrewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void spawnCrew();
                  if (e.key === "Escape") {
                    setNaming(false);
                    setCrewName("");
                  }
                }}
                onBlur={() => {
                  if (!crewName.trim()) setNaming(false);
                }}
                placeholder="Name it, then press Enter"
                aria-label="New crew name"
                className="w-full rounded-[4px] border-[0.5px] border-line-soft bg-bg-0 px-2 py-1 text-xs text-text-1 placeholder:text-text-5 focus:border-accent focus:outline-none"
              />
            </div>
          )}
        </PlaceRailGroup>
      ) : null}

      {/* What already happened. No `empty` line, so a project that has never
          run its crew simply doesn't carry the group — the answer to "did that
          land?" is only worth rail once there is something to answer it with.
          A row narrows the place to the goal that run targeted, which is the
          one useful thing you can do with a finished run. */}
      <PlaceRailGroup title="Recent runs" count={runRows.length} defaultOpen={false}>
        {runRows.map(({ run, outcome, scope, color }) => (
          <PlaceRailRow
            key={run.id}
            label={`${scope} · ${outcome}`}
            title={`${scope} · ${outcome}, ${relativeAgeAuto(run.started_at)}`}
            glyph={
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: color }}
                aria-hidden
              />
            }
            active={!!run.goal && shared.goal?.id === run.goal}
            onClick={() => {
              // A whole-queue run has no goal to narrow to, so its row is a
              // read-only line rather than a lie about being clickable.
              if (run.goal) selectGoal(run.goal);
            }}
          />
        ))}
      </PlaceRailGroup>
    </>
  );
}
