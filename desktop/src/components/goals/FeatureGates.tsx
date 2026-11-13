// FeatureGates — the three at-a-glance reads on a feature: Confidence (how much
// is built + checked), Risk (what could bite you), Drift (did the plan hold).
// Each is a figure with a plain value and one plain sentence of why — no code
// names, no invented numbers. The value is the reading; a bar drawn beside it
// said the same thing twice. Above them, a single line answers the question
// the whole panel exists for: is this finished?
//
// Colour is status, not brand: green reads good, yellow "watch", red "problem",
// plain "not checked". A gate is a readout, not an action, so nothing here
// looks clickable.

import type { FeatureSignals, Gate, GateBand } from "../../lib/featureSignals";
import { TraceVerdict } from "../ui/trace-report";
import { TraceStat, TraceStats } from "../ui/trace-stats";
import "./goals.css";

const BAND_TONE: Record<GateBand, "good" | "warn" | "bad" | undefined> = {
  strong: "good",
  fair: "warn",
  weak: "bad",
  unknown: undefined,
};

function GateStat({ gate }: { gate: Gate }) {
  return (
    <TraceStat label={gate.label} sub={gate.rationale}>
      <span className="ui-goal-gate-value" data-tone={BAND_TONE[gate.band]}>
        {gate.value}
      </span>
    </TraceStat>
  );
}

/** The three gates plus the overall "is it finished" headline. Render only when
 *  `signals.rated` — an unchecked goal has no signal to show and the card's own
 *  verdict already says so.
 *
 *  `driftOverride`, when supplied, replaces the synchronous heuristic Drift with
 *  the real intent-vs-actual reading across the feature's commits (see
 *  useFeatureDrift). It resolves a beat later than first paint, so the heuristic
 *  shows first and this swaps in — never a blank while it loads. */
export function FeatureGates({
  signals,
  driftOverride,
  headline = true,
}: {
  signals: FeatureSignals;
  driftOverride?: Gate | null;
  /** Off where the same sentence already sits right above (a goal's own
   *  reason line), so it isn't said twice. */
  headline?: boolean;
}) {
  const drift = driftOverride ?? signals.drift;
  return (
    <div className="ui-goal-gates">
      {headline ? (
        <TraceVerdict tone={signals.done ? "good" : signals.rated ? "warn" : "muted"} title={signals.headline} />
      ) : null}
      <TraceStats label="How finished this feature is">
        <GateStat gate={signals.confidence} />
        <GateStat gate={signals.risk} />
        <GateStat gate={drift} />
      </TraceStats>
    </div>
  );
}
