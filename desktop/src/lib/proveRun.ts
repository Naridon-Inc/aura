// Re-check a run's goals against the code, and record what came back.
//
// Two surfaces need this: the goal card's own "check again", and the list of
// what a finished run still owes, where "this was checked against older code"
// is only useful next to the button that fixes it. The recording rules — anchor
// to the run's own commit, stamp the verdict under the run's key, keep the
// association even when the check errors — are the same in both places, so they
// live here rather than being written out twice and drifting.

import { recordRun, verdictFromProve, type GoalRecord, type GoalRun } from "./goalStore";
import { runProve } from "./prove";

export type ProveRunOptions = {
  /** The run the verdicts are recorded under. */
  runKey: string;
  /** What was asked here, for the run's label in the goal's history. */
  runLabel: string;
  agentId?: string;
  /** The commit to check against, so a run whose code is on another branch is
   *  measured against its own work rather than whatever is checked out. */
  atCommit?: string;
};

export type ProveRunResult = {
  /** How many goals came back with a verdict. */
  checked: number;
  /** Why it couldn't be done, in plain words. Empty when every goal was
   *  checked. A failure here never closes anything: the goals keep whatever
   *  verdict they had, and the caller reports this. */
  error: string;
};

export async function proveRunGoals(
  repoRoot: string,
  goals: GoalRecord[],
  opts: ProveRunOptions,
): Promise<ProveRunResult> {
  if (goals.length === 0) {
    return { checked: 0, error: "There's no goal on this run to check." };
  }
  let checked = 0;
  let firstError = "";
  for (const goal of goals) {
    try {
      const result = await runProve(repoRoot, goal.text, opts.atCommit);
      const { verdict, ok, total } = verdictFromProve(result);
      recordRun(repoRoot, goal.id, run(opts, { verdict, ok, total }));
      checked += 1;
    } catch (e) {
      // The goal keeps its association with the run and becomes re-checkable;
      // what it must not do is keep an older verdict that now reads as current.
      recordRun(repoRoot, goal.id, run(opts, { verdict: "unknown", ok: 0, total: 0 }));
      if (!firstError) firstError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    checked,
    error: firstError ? `Aura couldn't finish checking: ${firstError}` : "",
  };
}

function run(
  opts: ProveRunOptions,
  outcome: Pick<GoalRun, "verdict" | "ok" | "total">,
): GoalRun {
  return {
    runKey: opts.runKey,
    label: opts.runLabel,
    agentId: opts.agentId,
    verdict: outcome.verdict,
    ok: outcome.ok,
    total: outcome.total,
    at: Date.now(),
    commit: opts.atCommit ?? null,
  };
}
