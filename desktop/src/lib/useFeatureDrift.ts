// useFeatureDrift — the honest Drift gate, upgraded from a proof-regression
// heuristic to Aura's real intent-vs-actual signal across a feature's commits.
//
// For every commit a feature landed on, Aura's pre-commit pass already scores
// whether the code that actually changed matches what was asked for — an
// identifier that gets touched but never appears in the stated intent is code
// nobody requested. This hook reads that score for each of the feature's commits
// and folds them into one plain Drift read: did the work stay true to the ask as
// the feature came together, or did it wander into changes nobody asked for?
//
// It's the real measurement, not a guess — but it costs one CLI call per commit,
// so it resolves asynchronously and returns null until it has a signal (and null
// whenever the feature has no commits behind it yet). Callers keep showing the
// synchronous heuristic Drift meanwhile and swap this one in when it lands. This
// is the drift signal a competitor without an AST simply can't compute.

import { useEffect, useState } from "react";
import type { Gate } from "./featureSignals";
import type { GoalRun } from "./goalStore";
import { fetchIntentMatch, type IntentBanner } from "./useIntentMatch";

type Alignment = { banner: IntentBanner; score: number };

/** Fold per-commit intent-vs-actual results into the Drift gate. Weighs only
 *  commits Aura could actually score (a commit with no recorded intent reads
 *  "unknown" and is set aside, never counted as drift). Returns null when there
 *  is nothing scorable — the caller then falls back to the heuristic. */
export function driftFromAlignments(aligns: Alignment[]): Gate | null {
  const known = aligns.filter((a) => a.banner !== "unknown");
  if (known.length === 0) return null;
  const diverged = known.filter((a) => a.banner === "diverged").length;
  const slipped = known.filter((a) => a.banner === "drift").length;
  const avg = known.reduce((sum, a) => sum + a.score, 0) / known.length;
  const pct = Math.max(0, Math.min(100, Math.round(avg * 100)));
  const n = known.length;
  const noun = `commit${n === 1 ? "" : "s"}`;

  if (diverged === 0 && slipped === 0) {
    return {
      key: "drift",
      label: "Drift",
      value: "Held",
      pct,
      band: "strong",
      rationale: `Held true to the ask — across all ${n} ${noun}, the code that changed is what was asked for.`,
    };
  }
  const off = diverged + slipped;
  return {
    key: "drift",
    label: "Drift",
    value: diverged > 0 ? "Diverged" : "Slipped",
    pct,
    band: diverged > 0 ? "weak" : "fair",
    rationale: `${off} of ${n} ${noun} changed code the ask didn't mention — the work drifted from what was requested.`,
  };
}

/** Score a feature's Drift from the real intent-vs-actual signal across its
 *  distinct commits. Returns null while loading, when there are no commits, or
 *  when none could be scored — so a caller can fall back to the heuristic gate. */
export function useFeatureDrift(
  repoRoot: string | undefined,
  runs: GoalRun[],
): Gate | null {
  const commits = Array.from(
    new Set(runs.map((r) => r.commit).filter((c): c is string => !!c)),
  );
  // Stable dependency key — the set of commits, order-independent.
  const key = commits.slice().sort().join(",");
  const [gate, setGate] = useState<Gate | null>(null);

  useEffect(() => {
    if (!repoRoot || commits.length === 0) {
      setGate(null);
      return;
    }
    let alive = true;
    void Promise.all(commits.map((sha) => fetchIntentMatch(repoRoot, sha)))
      .then((results) => {
        if (!alive) return;
        setGate(driftFromAlignments(results.map((m) => ({ banner: m.banner, score: m.score }))));
      })
      .catch(() => {
        if (alive) setGate(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, key]);

  return gate;
}
