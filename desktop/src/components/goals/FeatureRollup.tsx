// FeatureRollup — the whole feature at a glance, when it's made of more than one
// goal. A feature is rarely a single ask: it's several goals, often worked in
// different sessions and landed across several commits, that together make the
// thing. This rolls all of them into one read — how many goals are reached, how
// much of the whole is in place, and the merged thread of every check across
// every session and commit — so the answer to "is this feature finished?" is one
// honest line, not a card-by-card hunt.
//
// It only shows for a real feature (two or more goals with something proven);
// for a lone goal its own card already carries the same gates.

import { useMemo } from "react";
import { aggregateFeatureSignals } from "../../lib/featureSignals";
import { useFeatureDrift } from "../../lib/useFeatureDrift";
import type { GoalRecord } from "../../lib/goalStore";
import { FeatureGates } from "./FeatureGates";
import { FeatureHistory } from "./FeatureHistory";
import { FeatureRoles } from "./FeatureRoles";

export function FeatureRollup({ repoRoot, goals }: { repoRoot: string; goals: GoalRecord[] }) {
  const agg = useMemo(() => aggregateFeatureSignals(goals), [goals]);
  // Real intent-vs-actual Drift across every commit the whole feature landed on
  // (async; falls back to the aggregate heuristic until it resolves).
  const driftReal = useFeatureDrift(repoRoot, agg.runs);
  // A single goal shows the same gates on its own card; the rollup earns its
  // space only for a feature of several goals with real proof to combine.
  if (goals.length < 2 || !agg.signals.rated) return null;
  return (
    <div className="mb-2.5 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-3">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="section-label">
          This feature
        </h3>
        <span className="text-xs text-text-4">
          {agg.goalsReached}/{agg.goalsTotal} goals reached · across every session that worked it
        </span>
      </div>
      <FeatureGates signals={agg.signals} driftOverride={driftReal} />
      {agg.runs.length > 0 ? (
        <div className="mt-3 border-t border-line-soft pt-3">
          <FeatureHistory runs={agg.runs} />
        </div>
      ) : null}
      <FeatureRoles runs={agg.runs} className="mt-3 border-t border-line-soft pt-3" />
    </div>
  );
}
