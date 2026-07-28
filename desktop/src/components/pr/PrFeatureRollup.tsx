// PrFeatureRollup — the feature thread, rolled up to a PR. A feature already
// spans sessions and commits (FeatureRollup); this closes the loop the ask asked
// for — "…and PR" — by scoping the same honest read to just the commits on this
// pull request. It answers, in one plain line above the diff: is the thing this
// branch set out to build actually finished, or is it still open?
//
// It reads the goals whose proof runs landed on this PR's commits (the join in
// prFeature), folds them with the same aggregate signals every other feature
// surface uses (Confidence / Risk / real intent-vs-actual Drift), and shows the
// merged thread + who worked it. It renders nothing when this PR carries no
// proven goals yet, or when the branch tips aren't present locally to scope it —
// never a guess, never a wrong scope.

import { useEffect, useMemo, useState } from "react";
import { api, type GraphCommit } from "../../lib/api";
import { hydrateFromLedger, useGoals } from "../../lib/goalStore";
import { ledgerList } from "../../lib/goalLedger";
import { aggregateFeatureSignals } from "../../lib/featureSignals";
import { useFeatureDrift } from "../../lib/useFeatureDrift";
import { commitsInPr, goalsForCommits } from "../../lib/prFeature";
import { FeatureGates } from "../goals/FeatureGates";
import { FeatureHistory } from "../goals/FeatureHistory";
import { FeatureRoles } from "../goals/FeatureRoles";

// Deep enough to reach the merge-base for any realistic PR while staying cheap.
const GRAPH_LIMIT = 500;

export function PrFeatureRollup({
  repoRoot,
  headRef,
  baseRef,
}: {
  repoRoot: string;
  headRef: string;
  baseRef: string;
}) {
  const goals = useGoals(repoRoot);
  const [graph, setGraph] = useState<GraphCommit[] | null>(null);

  // Pull the durable goal ledger into the store — the PR pane may be reached
  // without ever visiting a task, so nothing else guarantees it's hydrated.
  useEffect(() => {
    let alive = true;
    void ledgerList(repoRoot).then((records) => {
      if (alive) hydrateFromLedger(repoRoot, records);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => {
    let alive = true;
    api
      .gitCommitGraph(repoRoot, GRAPH_LIMIT)
      .then((g) => {
        if (alive) setGraph(g);
      })
      .catch(() => {
        if (alive) setGraph(null);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const prGoals = useMemo(() => {
    if (!graph) return null;
    const commits = commitsInPr(graph, headRef, baseRef);
    if (!commits) return null;
    return goalsForCommits(goals, commits);
  }, [graph, goals, headRef, baseRef]);

  const agg = useMemo(
    () => (prGoals && prGoals.length > 0 ? aggregateFeatureSignals(prGoals) : null),
    [prGoals],
  );
  const driftReal = useFeatureDrift(repoRoot, agg?.runs ?? []);

  if (!agg || !agg.signals.rated) return null;

  return (
    <section className="rounded-lg border border-line-soft bg-bg-1 px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
          Is this PR&apos;s feature finished?
        </h3>
        <span className="text-[10.5px] text-text-4">
          {agg.goalsReached}/{agg.goalsTotal} goal{agg.goalsTotal === 1 ? "" : "s"} reached · across
          the commits on this PR
        </span>
      </div>
      <FeatureGates signals={agg.signals} driftOverride={driftReal} />
      {agg.runs.length > 0 ? (
        <div className="mt-3 border-t border-line-soft pt-3">
          <FeatureHistory runs={agg.runs} />
        </div>
      ) : null}
      <FeatureRoles runs={agg.runs} className="mt-3 border-t border-line-soft pt-3" />
    </section>
  );
}
