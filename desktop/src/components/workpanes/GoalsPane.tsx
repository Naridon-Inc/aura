// GoalsPane — your tasks, and whether the code shows them done, told the way
// the rest of Trace is: one column, each goal a plain sentence on the timeline
// with one muted line under it (Done / Almost / Not yet, when it was checked,
// where it sits on the board), grouped by what the tasks add up to.
//
// The tension this surfaces is the point: a task marked *done* whose check
// reads *Not yet* is the AI claiming success the code doesn't back up. Checking
// is lazy — a goal shows its last known answer until you press Check (or Check
// all), so opening the page is instant. Open a goal and it reads as a short
// story: what it means, what shows it's done, and where it lives. ↑ and ↓ move
// between goals; Back, or Esc, returns with the same goal marked.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Target } from "lucide-react";
import { captureFocus } from "../../lib/focusReturn";
import { runProveStructured, type ProveOutcome } from "../../lib/prove";
import { isTaskDone, type TaskGoal } from "../../lib/taskGoals";
import { useTaskGoalGroups } from "../../lib/taskGoalGroups";
import {
  hydrateFromLedger,
  linkTask,
  recordRun,
  upsertGoalByText,
  verdictFromOutcome,
} from "../../lib/goalStore";
import { ledgerList, ledgerProve } from "../../lib/goalLedger";
import { MeaningPlanePanel } from "../commons/MeaningPlanePanel";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceStory, TraceStoryDay, TraceStoryHead, TraceStoryIntro } from "../ui/trace-story";
import { TraceTimeline } from "../ui/trace-timeline";
import { GoalMoment } from "../trace/story/GoalMoment";
import { GoalStory } from "../trace/story/GoalStory";
import { StoryLinks } from "../trace/story/StoryLinks";
import { useMomentKeys } from "../trace/story/StoryDays";
import { GOALS_SHOWN } from "../trace/story/goalStoryText";
import { formatCount } from "../trace/story/storyFormat";

type Props = { repoRoot: string };

export function GoalsPane({ repoRoot }: Props) {
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

  // The goal last opened stays marked, and focus goes back to it, on return.
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const listFocus = useRef<() => void>(() => {});
  // Groups showing every goal rather than the first few.
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  // The portable "why + proof" record, read only once it's asked for.
  const [meaningOpen, setMeaningOpen] = useState(false);
  const onKeyDown = useMomentKeys();

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
  const done = useMemo(() => goals.filter((g) => g.verdict === "verified").length, [goals]);
  const busy = checking.size > 0;
  const read = !(loading && goals.length === 0);

  const openGoal = useCallback((id: string) => {
    listFocus.current = captureFocus(document.activeElement, document.body);
    setLastOpened(id);
    setSelectedId(id);
  }, []);
  const closeGoal = useCallback(() => setSelectedId(null), []);
  useEffect(() => {
    if (selectedId) return;
    listFocus.current();
    listFocus.current = () => {};
  }, [selectedId]);

  return (
    <div className="ui-trace-page-body">
      <div className="ui-trace-page-body" hidden={!!selected}>
        <TraceStory label="Goals">
          <TraceStoryHead
            icon={<Target aria-hidden />}
            control={
              openTasks.length > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void checkMany(openTasks)}
                  disabled={busy}
                  title="Check every open task against the code as it is now"
                >
                  {busy ? "Checking…" : `Check all ${formatCount(openTasks.length)}`}
                </Button>
              ) : undefined
            }
          >
            {read ? (
              <>
                <strong>{formatCount(goals.length)}</strong> {goals.length === 1 ? "goal" : "goals"} ·{" "}
                <strong>{formatCount(done)}</strong> done
              </>
            ) : (
              "Reading your task board"
            )}
          </TraceStoryHead>
          <TraceStoryIntro>
            Your tasks, and whether the code shows them done, grouped by what they add up to. Open one
            to see what is in place and what is still missing.
          </TraceStoryIntro>
          {error && goals.length === 0 ? (
            <ErrorState title="Couldn’t read your task board" message={error} size="sm" />
          ) : !read ? (
            <LoadingState label="Reading your task board…" />
          ) : goals.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No goals yet"
              body="Your goals are your tasks. Write one on the board, saying what should work once it's done, and it shows up here with a plain answer: did the AI actually build it?"
              size="sm"
            />
          ) : (
            <div className="ui-trace-story-days" onKeyDown={onKeyDown}>
              {groups.map((group) => {
                const all = showAll.has(group.id);
                const shown = all ? group.tasks : group.tasks.slice(0, GOALS_SHOWN);
                return (
                  <TraceStoryDay key={group.id} label={<span title={group.meaning}>{group.title}</span>}>
                    <TraceTimeline label={group.title}>
                      {shown.map((t) => (
                        <GoalMoment
                          key={t.id}
                          goal={t}
                          busy={checking.has(t.id)}
                          errored={checkErrors.has(t.id)}
                          active={t.id === lastOpened}
                          onOpen={() => openGoal(t.id)}
                        />
                      ))}
                    </TraceTimeline>
                    <StoryLinks
                      links={[
                        !all &&
                          group.tasks.length > GOALS_SHOWN && {
                            label: `Show all ${formatCount(group.tasks.length)}`,
                            go: () => setShowAll((prev) => new Set(prev).add(group.id)),
                          },
                      ]}
                    />
                  </TraceStoryDay>
                );
              })}
              <StoryLinks
                links={[
                  {
                    label: meaningOpen ? "Hide why & proof" : "Why & proof, on this copy",
                    title: "The reason behind each change, and whether it checks out. Travels with the repo.",
                    go: () => setMeaningOpen((v) => !v),
                  },
                ]}
              />
              {meaningOpen && <MeaningPlanePanel repoRoot={repoRoot} />}
            </div>
          )}
        </TraceStory>
      </div>
      {selected && (
        <GoalStory
          key={selected.id}
          repoRoot={repoRoot}
          goal={selected}
          outcome={outcomes[selected.id] ?? null}
          busy={checking.has(selected.id)}
          errored={checkErrors.has(selected.id)}
          onCheck={() => void check(selected)}
          onBack={closeGoal}
        />
      )}
    </div>
  );
}
