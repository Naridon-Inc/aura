// crewControl — pure helpers for the Crew **Control** tab (W-B run controls +
// W-C crews). No I/O, no React: just the plain-language naming and the
// deterministic rollups the control cards render, so the tab stays a thin view
// over the engine's `goals` / `crews` summaries and the run ledger.

import type {
  GoalSummary,
  LoopTask,
  ReadyViewDto,
  RunRecord,
} from "../../../lib/api";
import { sentenceCase } from "../../../lib/textCase";
import { WORK_STATE } from "../../../lib/workState";

/** Turn a goal slug (`spot-unusual-numbers`) into a human title
 *  ("Spot unusual numbers"). The engine tags goals as `goal:<slug>`; the
 *  surface should never show the slug. */
export function humanizeGoal(slug: string): string {
  // A goal is a phrase, not a name, so it takes sentence case — see
  // lib/textCase.
  return sentenceCase(slug.replace(/[_-]+/g, " ").trim()) || "Untitled goal";
}

/** What a goal can do right now, read off its live counts — so the card only
 *  offers the buttons that mean something. */
export type GoalAffordances = {
  /** There is ready work to dispatch. */
  canRun: boolean;
  /** Something is ready or in-flight, so there's something to park. */
  canPause: boolean;
  /** Something is parked, so there's something to un-park. */
  canResume: boolean;
  /** done / total, for the progress read. */
  done: number;
  total: number;
  /** Every count reached a terminal state. */
  finished: boolean;
};

export function goalAffordances(g: GoalSummary): GoalAffordances {
  const canRun = g.ready > 0;
  const canPause = g.ready > 0 || g.working > 0;
  const canResume = g.paused > 0;
  const finished = g.total > 0 && g.done + g.failed >= g.total;
  return { canRun, canPause, canResume, done: g.done, total: g.total, finished };
}

/** The one thing about a goal most worth knowing right now, in the state's own
 *  colour: who's on it, what broke, what's left. Not a progress bar AND a
 *  done/total AND a sentence — one line, because a rail row has room for one.
 *
 *  Lived inside the plan sidebar until that sidebar went. It is a pure read of
 *  a `GoalSummary`, and the rail draws goals now, so it belongs beside the rest
 *  of the goal arithmetic rather than inside whichever component happens to
 *  render it. */
export function goalTail(goal: GoalSummary): { text: string; color: string } {
  if (goal.working > 0) {
    return { text: `${goal.working} working`, color: WORK_STATE.working.color };
  }
  if (goal.failed > 0) {
    return { text: `${goal.failed} failed`, color: WORK_STATE.failed.color };
  }
  if (goalAffordances(goal).finished) {
    return { text: "Done", color: WORK_STATE.done.color };
  }
  if (goal.ready > 0) {
    return { text: `${goal.ready} ready`, color: "var(--color-accent)" };
  }
  if (goal.paused > 0) {
    return { text: "Paused", color: "var(--color-text-4)" };
  }
  return { text: `${goal.done}/${goal.total}`, color: "var(--color-text-4)" };
}

/** A goal's state as the SAME per-group glyph the tasks board draws for a
 *  status: half-filled while an agent works, filled red on a failure, filled
 *  green when finished, a solid ring when there's ready work, a dashed ring
 *  when it's only queued. One vocabulary of dots across the whole place. */
export function goalGlyph(g: GoalSummary): { group: string; color: string } {
  if (g.working > 0)
    return { group: "started", color: WORK_STATE.working.color };
  if (g.failed > 0)
    return { group: "completed", color: WORK_STATE.failed.color };
  if (g.total > 0 && g.done >= g.total)
    return { group: "completed", color: WORK_STATE.done.color };
  if (g.ready > 0) return { group: "unstarted", color: "var(--color-accent)" };
  return { group: "backlog", color: "var(--color-text-5)" };
}

/** The goals with at least one task still in `have` — the ids of a queue that
 *  has already been narrowed to one crew by `scopeViewToCrew`. `crew === null`
 *  (all crews) keeps every goal.
 *
 *  This used to read `crews[].summary.goals` instead, which sorted goals by a
 *  DIFFERENT rule than the one the runner sorts tasks by. Two partitions of the
 *  same board disagree the moment a goal spans crews or a loose task is tagged
 *  into one: the list would show a goal whose work Run wouldn't touch, or hide
 *  one whose work it would. There is one partition now — a node's crew_id — and
 *  the goal list is simply which goals still have work under it. */
export function goalsForCrew(
  goals: GoalSummary[],
  have: { has(id: string): boolean },
  crew: string | null,
): GoalSummary[] {
  if (crew === null) return goals;
  return goals.filter((g) => g.task_ids.some((id) => have.has(id)));
}

/** The crew a node belongs to. Mirrors `crew_of` in aura-loop exactly: the
 *  node's own `crew_id`, or the default "main" crew when it was never assigned
 *  one. The runner scopes a crew run on this and nothing else. */
export function crewOf(task: LoopTask): string {
  return task.crew_id ?? "main";
}

/** How many of these nodes a run scoped to `crew` would actually take.
 *  `crew === null` (all crews) counts them all.
 *
 *  This exists because the footer used to put the WHOLE graph's ready count
 *  beside Run while Run itself was scoped to the focused crew — so with a crew
 *  in focus the button offered to work "up to N of 24 ready" and then took
 *  three. Same partition as `RunScope::matches`, so the number and the verb
 *  can't disagree. */
export function readyForCrew(ready: LoopTask[], crew: string | null): number {
  if (crew === null) return ready.length;
  return ready.reduce((n, t) => (crewOf(t) === crew ? n + 1 : n), 0);
}

/** The same queue with only one crew's nodes in it — every bucket filtered and
 *  the counts re-derived, so anything drawn from it (the situation line, the
 *  Board, the Graph) narrows together and cannot disagree with the Run beside
 *  it. `crew === null` (all crews) hands the view straight back.
 *
 *  Focusing a crew used to change two things on a page of ten: the goal list in
 *  the sidebar, and which tasks Run picked up. The board kept every other crew's
 *  cards, so the chip said "this crew only" over a screen that plainly wasn't.
 *
 *  `goals` and `crews` are left alone — the sidebar narrows goals itself, off
 *  the tasks that survive here, and the crew switcher has to keep listing the
 *  crews you are not currently in. */
export function scopeViewToCrew(
  view: ReadyViewDto,
  crew: string | null,
): ReadyViewDto {
  if (crew === null) return view;
  const mine = (t: LoopTask): boolean => crewOf(t) === crew;
  const ready = view.ready.filter(mine);
  const blocked = view.blocked.filter((b) => mine(b.task));
  const working = view.working.filter(mine);
  const done = view.done.filter(mine);
  const paused = view.paused.filter(mine);
  const other = view.other.filter(mine);
  return {
    ...view,
    ready,
    blocked,
    working,
    done,
    paused,
    other,
    counts: {
      ready: ready.length,
      blocked: blocked.length,
      working: working.length,
      done: done.length,
      paused: paused.length,
      other: other.length,
    },
  };
}

/** Every node in the view exactly once. The six buckets are a partition of the
 *  graph, so concatenating them is the whole graph — no node counted twice, and
 *  none of them missed because it happened to be paused.
 *
 *  Deliberately not `crewQueue.allTasks`, which flattens five of the six and
 *  drops `paused`. That is survivable for the queue view it was written for and
 *  is not survivable here: a goal parked out of the ready set would resolve to
 *  none of its board cards, so picking it in the rail would empty the board and
 *  read as "this goal has no work". */
export function allNodes(view: ReadyViewDto): LoopTask[] {
  return [
    ...view.ready,
    ...view.blocked.map((b) => b.task),
    ...view.working,
    ...view.done,
    ...view.paused,
    ...view.other,
  ];
}

/** The board cards a goal's work was projected from.
 *
 *  This is the join that lets one rail drive both halves of Tasks. Pick a goal
 *  and the loop views narrow by its member nodes; the List and the Board have
 *  never heard of a loop node, but every node projected from a card carries the
 *  card's id in `board_task_id`, so the same pick narrows them too — to the
 *  cards the goal is actually made of, not to a text match on a label.
 *
 *  Nodes authored straight into the graph have no card and contribute nothing;
 *  a goal made only of those returns empty, which is the truthful answer to
 *  "which of my cards are in this goal?" and is why callers must treat empty as
 *  "no card-level narrowing available" rather than "no cards match". */
export function boardTaskIdsForGoal(
  view: ReadyViewDto,
  goalSlug: string,
): string[] {
  const summary = view.goals.find((g) => g.goal === goalSlug);
  if (!summary) return [];
  const members = new Set(summary.task_ids);
  return boardIdsOf(view, (t) => members.has(t.id));
}

/** The board cards a crew's work was projected from — the crew-shaped twin of
 *  `boardTaskIdsForGoal`, over the same partition the runner uses (`crewOf`),
 *  so picking a crew in the rail narrows List and Board to exactly the cards
 *  that crew's Run would touch. */
export function boardTaskIdsForCrew(
  view: ReadyViewDto,
  crew: string,
): string[] {
  return boardIdsOf(view, (t) => crewOf(t) === crew);
}

/** Every board card's goal, in one pass: card id → the goal's plain name.
 *
 *  The inverse of `boardTaskIdsForGoal`, and the reason it exists separately is
 *  cost. That function answers for ONE goal by walking every node; asking it
 *  per goal to tag a list walks the graph once per goal, and this walks it
 *  once. A list of a thousand rows re-tags on every poll of the loop, so the
 *  difference is the difference between a tag and a stutter.
 *
 *  A card cut into several steps under one goal is named once. A card whose
 *  steps somehow span two goals keeps the first — the graph is not supposed to
 *  produce that, and a row can only wear one tag. */
export function goalOfBoardTask(view: ReadyViewDto): Record<string, string> {
  const goalOfNode = new Map<string, string>();
  for (const g of view.goals) {
    const name = humanizeGoal(g.goal);
    for (const id of g.task_ids) {
      if (!goalOfNode.has(id)) goalOfNode.set(id, name);
    }
  }
  const out: Record<string, string> = {};
  for (const t of allNodes(view)) {
    const board = t.board_task_id;
    if (!board || out[board]) continue;
    const goal = goalOfNode.get(t.id);
    if (goal) out[board] = goal;
  }
  return out;
}

/** Distinct `board_task_id`s of the matching nodes, in graph order. A slice can
 *  hold several steps cut from one card, and the card is named once. */
function boardIdsOf(
  view: ReadyViewDto,
  match: (t: LoopTask) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of allNodes(view)) {
    if (!match(t)) continue;
    const board = t.board_task_id;
    if (board && !seen.has(board)) {
      seen.add(board);
      out.push(board);
    }
  }
  return out;
}

/** The same queue with only one goal's nodes in it — the goal-shaped twin of
 *  `scopeViewToCrew`, and deliberately the same shape of answer: every bucket
 *  filtered and every count re-derived, so the situation line, the Board and
 *  the Graph narrow together. `goal === null` hands the view straight back.
 *
 *  Membership comes from the goal's own `task_ids` rather than from re-reading
 *  each node's `goal:` tag. The rail lists goals out of `view.goals`; if this
 *  partitioned by a second rule the rail could offer a goal whose work the
 *  scoped view then didn't contain — the exact disagreement `goalsForCrew`
 *  documents one function up.
 *
 *  `goals` and `crews` are left alone for the same reason `scopeViewToCrew`
 *  leaves them: the rail has to keep listing the goals you are not in. */
export function scopeViewToGoal(
  view: ReadyViewDto,
  goal: string | null,
): ReadyViewDto {
  if (goal === null) return view;
  const summary = view.goals.find((g) => g.goal === goal);
  // An unknown slug narrows to nothing rather than to everything: a rail
  // pointing at a goal the graph no longer has must not read as "all work".
  const members = new Set(summary?.task_ids ?? []);
  const mine = (t: LoopTask): boolean => members.has(t.id);
  const ready = view.ready.filter(mine);
  const blocked = view.blocked.filter((b) => mine(b.task));
  const working = view.working.filter(mine);
  const done = view.done.filter(mine);
  const paused = view.paused.filter(mine);
  const other = view.other.filter(mine);
  return {
    ...view,
    ready,
    blocked,
    working,
    done,
    paused,
    other,
    counts: {
      ready: ready.length,
      blocked: blocked.length,
      working: working.length,
      done: done.length,
      paused: paused.length,
      other: other.length,
    },
  };
}

/** The runs that drained a given goal, newest first. Header "Run all" passes no
 *  goal (those records carry `goal: null`), so a goal card only ever shows the
 *  runs that actually targeted it. */
export function runsForGoal(runs: RunRecord[], goalSlug: string): RunRecord[] {
  return runs.filter((r) => r.goal === goalSlug);
}

/** A one-line outcome summary for a run row: "3 done · 1 failed" (skips zero
 *  parts) or "no work" when it attempted nothing. */
export function runOutcomeLabel(run: RunRecord): string {
  const parts: string[] = [];
  if (run.completed > 0) parts.push(`${run.completed} done`);
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  const skipped = run.attempted - run.completed - run.failed;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.length ? parts.join(" · ") : "no work";
}

/** Whole-graph "run all" scope label for the run-history list — what a record
 *  with no goal/crew targeted. */
export function runScopeLabel(run: RunRecord): string {
  if (run.goal) return humanizeGoal(run.goal);
  if (run.crew && run.crew !== "main") return `${run.crew} crew`;
  return "Whole queue";
}
