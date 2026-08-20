// FeatureGates — the three at-a-glance reads on a feature: Confidence (how much
// is built + checked), Risk (what could bite you), Drift (did the plan hold).
// Each is a compact card with a plain value, a five-segment health bar, and one
// plain sentence of why — no code names, no invented numbers. Above them, a
// single line answers the question the whole card exists for: is this finished?
//
// Colour is status, not brand: green reads good, amber "watch", red "problem",
// muted "not checked". The arctic-blue accent is deliberately kept off these —
// it's reserved for things you click, and a gate is a readout, not an action.

import type { FeatureSignals, Gate, GateBand } from "../../lib/featureSignals";

const BAND_COLOR: Record<GateBand, string> = {
  strong: "var(--color-accent-green)",
  fair: "var(--color-amber)",
  weak: "var(--color-red)",
  unknown: "var(--color-text-4)",
};

// Five discrete cells filled by the gate's 0–100 health — the segmented bar the
// competitor surfaces use, sized to read at a glance without a percentage.
function SegBar({ pct, color }: { pct: number; color: string }) {
  // Full only at 100, and never empty once there is something — the same
  // rule the number follows. Rounding filled all five segments at 99%, so a
  // feature one part short drew a finished bar.
  const filled =
    pct >= 100 ? 5 : pct <= 0 ? 0 : Math.min(4, Math.max(1, Math.floor(pct / 20)));
  return (
    <div className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className="h-1.5 flex-1 rounded-[1px]"
          style={{ background: i < filled ? color : "var(--color-bg-2)" }}
        />
      ))}
    </div>
  );
}

function GateCard({ gate }: { gate: Gate }) {
  const color = BAND_COLOR[gate.band];
  return (
    <div className="min-w-0 rounded-md border border-line-soft bg-bg-0 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-1">
        <span className="section-label">{gate.label}</span>
        <span className="text-base font-semibold tabular-nums" style={{ color }}>
          {gate.value}
        </span>
      </div>
      <div className="mt-1.5">
        <SegBar pct={gate.pct} color={color} />
      </div>
      <p className="mt-1.5 text-xs leading-snug text-text-4">{gate.rationale}</p>
    </div>
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
}: {
  signals: FeatureSignals;
  driftOverride?: Gate | null;
}) {
  const dot = signals.done
    ? "var(--color-accent-green)"
    : signals.rated
      ? "var(--color-amber)"
      : "var(--color-text-4)";
  const drift = driftOverride ?? signals.drift;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: dot }}
        />
        <p className="text-sm leading-snug text-text-2">{signals.headline}</p>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <GateCard gate={signals.confidence} />
        <GateCard gate={signals.risk} />
        <GateCard gate={drift} />
      </div>
    </div>
  );
}
