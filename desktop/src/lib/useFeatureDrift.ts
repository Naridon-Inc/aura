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
import { basisCanBeChecked, type IntentBasis } from "./intentBasis";
import { percentOf } from "./percent";

type Alignment = { banner: IntentBanner; score: number; basis?: IntentBasis };

/** Fold per-commit intent-vs-actual results into the Drift gate.
 *
 *  Only some of a feature's commits can be scored. A commit with no recorded
 *  intent reads "unknown", and a commit whose only "reason" was written by
 *  Aura from that same diff scores against itself (lib/intentBasis) — set
 *  both aside and neither can be counted as drift or as proof of its absence.
 *
 *  What's left is a *sample*, and every number this gate prints has to name
 *  which set it counted. "Across all 2 commits, the code that changed is what
 *  was asked for" was true of the sample and read as a verdict on the feature,
 *  even when ten more commits went unmeasured. So: the rationale always names
 *  the gap, and when the sample is under half the feature the gate stops
 *  claiming anything at all — the same "—" the heuristic shows when there
 *  aren't enough runs to see a trend.
 *
 *  Returns null only when the feature has no commits behind it yet. An
 *  unscoreable feature gets a real "couldn't check" gate, because null means
 *  "keep showing the placeholder" to every caller and an absence of evidence
 *  is not a loading state. */
export function driftFromAlignments(aligns: Alignment[]): Gate | null {
  const total = aligns.length;
  if (total === 0) return null;
  const known = aligns.filter(
    (a) => a.banner !== "unknown" && basisCanBeChecked(a.basis ?? "stated"),
  );
  const n = known.length;
  const noun = (k: number) => `commit${k === 1 ? "" : "s"}`;

  // Under half the feature scoreable: report the coverage, not a verdict.
  if (n * 2 < total) {
    return {
      key: "drift",
      label: "Drift",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale:
        n === 0
          ? `None of the ${total} ${noun(total)} behind this feature recorded a reason to check the code against. There's nothing to measure drift from.`
          : `Only ${n} of ${total} ${noun(total)} recorded a reason to check the code against, not enough to tell whether the work held to the ask.`,
    };
  }

  const diverged = known.filter((a) => a.banner === "diverged").length;
  const slipped = known.filter((a) => a.banner === "drift").length;
  const avg = known.reduce((sum, a) => sum + a.score, 0) / n;
  const pct = percentOf(avg);
  const unchecked = total - n;
  // Named in every sentence below — the reader has to be able to tell a clean
  // feature from a mostly-unrecorded one at a glance.
  const gap = unchecked
    ? ` The other ${unchecked} ${noun(unchecked)} recorded no reason to check against.`
    : "";

  if (diverged === 0 && slipped === 0) {
    return {
      key: "drift",
      label: "Drift",
      value: "Held",
      pct,
      band: "strong",
      rationale: `Held true to the ask. In ${unchecked ? `the ${n} ${noun(n)} Aura could check` : `all ${n} ${noun(n)}`}, the code that changed is what was asked for.${gap}`,
    };
  }
  const off = diverged + slipped;
  return {
    key: "drift",
    label: "Drift",
    value: diverged > 0 ? "Diverged" : "Slipped",
    pct,
    band: diverged > 0 ? "weak" : "fair",
    rationale: `${off} of ${unchecked ? `the ${n} ${noun(n)} Aura could check` : `${n} ${noun(n)}`} changed code the ask didn't mention. The work drifted from what was requested.${gap}`,
  };
}

/** Score a feature's Drift from the real intent-vs-actual signal across its
 *  distinct commits. Returns null only while there is no answer yet — loading,
 *  no repo, no commits, or a failed read — so a caller can fall back to the
 *  heuristic gate for that beat. Once it has read the commits it always
 *  answers, including "couldn't check": the heuristic measures proof
 *  regressions, a different question wearing the same label, and letting it
 *  stand in permanently would answer Drift with something that never looked
 *  at the ask. */
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
        setGate(
          driftFromAlignments(
            results.map((m) => ({ banner: m.banner, score: m.score, basis: m.basis })),
          ),
        );
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
