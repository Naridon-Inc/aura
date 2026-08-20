// Turning a ratio into a percent a person reads — one answer, app-wide.
//
// Sixteen surfaces do it. Transcribed verbatim and fed the same ratios:
//
//   199 of 200 done       →  100%  ×15   ·  99%  ×1
//   1149 of 1150 done     →  100%  ×15   ·  99%  ×1
//   1 of 300 done         →    0%  ×16
//   a score of 1.2        →  120%  ×12   · 100%  ×4
//   a score of −0.05      →   −5%  ×14   ·   0%  ×2
//
// ── The disagreement ─────────────────────────────────────────────────────
//
// TopBar and UpdateBanner both render the update download, both fed by the
// same `downloadUpdate(info, (done, total) => …)` callback — the same bytes,
// the same moment. TopBar rounds, UpdateBanner floors. At 49.6% of the file
// one strip says 50% and the other says 49%.
//
// ── The part that is not a disagreement ──────────────────────────────────
//
// Fifteen of the sixteen print "100%" for work that is not finished, because
// Math.round takes 99.5 upwards. Three places make that number a claim:
//
//   · ManagerChatView's ProverBlock paints the line green on `pct === 100`.
//     So a proof run with one failing check reads, in green:
//         199/200 PASSED · 100%
//     The colour is the app asserting every check passed. It did not.
//
//   · featureSignals computes the Confidence gate's BAND from the exact counts
//     (`ok === total`) and its VALUE by rounding. They can therefore disagree,
//     and the card in components/goals/FeatureGates renders both, one above
//     the other:
//         Confidence  100%
//         199 of 200 parts are built and checked; 1 still to go.
//
//   · The same card's five-segment bar filled `Math.round(pct / 20)` segments,
//     so 99% filled all five. Full bar, full number, one part missing.
//
// And in the other direction, "0%" for work that HAS started: one part of 300,
// or 0.4% of a quota left, both read as nothing at all.
//
// ── The rule ─────────────────────────────────────────────────────────────
//
// The two ends of this scale are not numbers, they are claims. 100% means
// finished; 0% means nothing has happened yet. So they are reserved: a ratio
// that is merely CLOSE to either end rounds to 99 or to 1, and only an exact
// one lands on the end. Everything between rounds normally.
//
// ── Where a different shape survives ─────────────────────────────────────
//
// A measurement is not a claim: TopBar's CPU readout, the context-window
// gauge and the timeline scrubber keep their decimals, because 100.0% CPU is
// a reading and not an assertion that something is complete. A zoom control
// keeps plain rounding for the same reason — "100%" there means actual size,
// and a zoom of 0.999 SHOULD say 100%. And a stacked bar's segment widths stay
// fractional, because they have to add up to the width of the bar.

/** A fraction (0–1) as the whole-number percent a person reads.
 *
 *  Honest at both ends: 100 only when the fraction really is 1, 0 only when it
 *  really is 0. A fraction of 0.995 reads 99, not 100 — it is not finished. A
 *  fraction of 0.003 reads 1, not 0 — it has started.
 *
 *  Anything outside 0–1 is clamped. Broken input — a NaN, an Infinity out of a
 *  divide by zero — reads 0 rather than 100: the wrong end to guess at is the
 *  one that claims the work is finished. */
export function percentOf(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 100;
  const rounded = Math.round(fraction * 100);
  // Close to an end is not the end.
  if (rounded >= 100) return 99;
  if (rounded <= 0) return 1;
  return rounded;
}

/** `part` out of `total` as the whole-number percent a person reads.
 *
 *  A total of zero — nothing to be a part of — reads 0. */
export function percent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return percentOf(part / total);
}

/** `part` out of `total`, written: "42%". */
export function percentText(part: number, total: number): string {
  return `${percent(part, total)}%`;
}
