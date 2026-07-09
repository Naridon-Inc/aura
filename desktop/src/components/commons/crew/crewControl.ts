// crewControl — pure helpers for the Crew **Control** tab (W-B run controls +
// W-C crews). No I/O, no React: just the plain-language naming and the
// deterministic rollups the control cards render, so the tab stays a thin view
// over the engine's `goals` / `crews` summaries and the run ledger.

import type { CrewRow, GoalSummary, RunRecord } from "../../../lib/api";

/** Turn a goal slug (`spot-unusual-numbers`) into a human title
 *  ("Spot unusual numbers"). The engine tags goals as `goal:<slug>`; the
 *  surface should never show the slug. */
export function humanizeGoal(slug: string): string {
  const words = slug
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Untitled goal";
  return words
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
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

/** The goals that belong to a crew. `crew === null` means "all crews" → every
 *  goal. Otherwise keep only the goals the crew's summary lists. A crew with no
 *  goals of its own (only loose tasks) yields an empty list, which the tab
 *  renders as "no goals yet — its tasks run from the queue". */
export function goalsForCrew(
  goals: GoalSummary[],
  crews: CrewRow[],
  crew: string | null,
): GoalSummary[] {
  if (crew === null) return goals;
  const row = crews.find((c) => c.meta.id === crew);
  if (!row) return [];
  const inCrew = new Set(row.summary.goals);
  return goals.filter((g) => inCrew.has(g.goal));
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
