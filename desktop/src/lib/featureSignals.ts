// featureSignals — read a feature's whole thread down to three plain gates a
// non-engineer can trust: is it actually built (Confidence), is anything unsafe
// hiding in it (Risk), and did the plan hold as the work went on (Drift).
//
// A "feature" here is a Goal: one durable record that already fans out to the
// task it sits under, every session/commit that worked it (its runs), and the
// verdict of Aura's AST proof each time. So these gates are NOT invented scores
// — every one traces to a real signal: the proof's built/total parts, the
// placeholders and dead-ends the proof found, and whether parts that were once
// proven stopped passing across the run history. That honesty is the whole
// point: the card can say "finished" only because the code backs it, not
// because an agent said so.

import type { GoalRecord, GoalRun, GoalVerdict } from "./goalStore";
import { rollup } from "./goalStore";
import type { ProveOutcome } from "./prove";

/** Which status colour a gate reads as. `strong` = green (good), `fair` = amber
 *  (watch), `weak` = red (problem), `unknown` = muted (not checked yet). */
export type GateBand = "strong" | "fair" | "weak" | "unknown";

/** One gate on a feature. `pct` is a 0–100 *health* fill (higher is always
 *  better, for every gate — a full green bar reads the same everywhere), which
 *  drives the segmented bar. `value` is the short word shown big; `rationale`
 *  is the one plain sentence explaining it, real signals only. */
export type Gate = {
  key: "confidence" | "risk" | "drift";
  label: string;
  value: string;
  pct: number;
  band: GateBand;
  rationale: string;
};

export type FeatureSignals = {
  confidence: Gate;
  risk: Gate;
  drift: Gate;
  /** One plain line answering "is this feature finished, and why" — the overall
   *  read the three gates roll up to. */
  headline: string;
  /** True only when the code fully backs the feature (every part built + checked)
   *  — the honest "safe to call it done". */
  done: boolean;
  /** True once there's any real proof to weigh (checked at least once, or a live
   *  outcome). When false, the gates carry no signal and the caller can hide
   *  them — the card's verdict already says "Not checked". */
  rated: boolean;
};

// ── the current proof snapshot ──────────────────────────────────────────────
// Prefer the live `aura prove` outcome when the card holds one (freshest), else
// fall back to the newest recorded run. Both carry the same built/total shape.

// `built` = how many parts actually exist in the code (regardless of whether
// they're wired up / pass). Known only from a live outcome — a recorded run
// stores just the pass count, not per-part existence — so it's optional. It's
// what lets the copy tell "built but not wired" apart from "not built at all".
type Proof = { ok: number; total: number; checked: boolean; built?: number };

function currentProof(goal: GoalRecord, outcome: ProveOutcome | null): Proof {
  if (outcome && outcome.total > 0) {
    return {
      ok: outcome.passed,
      total: outcome.total,
      checked: true,
      built: outcome.checks.filter((c) => c.exists).length,
    };
  }
  const r = rollup(goal);
  return { ok: r.ok, total: r.total, checked: r.at != null };
}

const ratio = (r: GoalRun): number => (r.total > 0 ? r.ok / r.total : 0);

/** How many times, walking the checks in order (oldest → newest), the share of
 *  proven parts dropped from one check to the next — i.e. a part that was in
 *  place stopped passing. A pure count off the recorded runs; it's the real
 *  signal behind both Risk (a regression is dangerous) and Drift (the work
 *  wandered from where it had got to). */
function regressionCount(runs: GoalRun[]): number {
  const rated = runs.filter((r) => r.total > 0).slice().reverse(); // oldest → newest
  let drops = 0;
  for (let i = 1; i < rated.length; i++) {
    if (ratio(rated[i]) < ratio(rated[i - 1]) - 1e-9) drops++;
  }
  return drops;
}

/** Join plain phrases as "a", "a and b", "a, b and c". */
function joinPlain(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ── the three gates ─────────────────────────────────────────────────────────

function confidenceGate(p: Proof): Gate {
  if (!p.checked || p.total === 0) {
    return {
      key: "confidence",
      label: "Confidence",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale:
        p.checked && p.total === 0
          ? "Aura couldn't work out what this feature needs yet."
          : "Not checked against the code yet.",
    };
  }
  const pct = Math.round((p.ok / p.total) * 100);
  const missing = p.total - p.ok;
  const band: GateBand = p.ok === p.total ? "strong" : p.ok > 0 ? "fair" : "weak";
  const built = Math.min(p.total, p.built ?? 0);
  const rationale =
    p.ok === p.total
      ? `Every part is built and checked — ${p.total} of ${p.total} in place.`
      : p.ok === 0
        ? built > 0
          ? built === p.total
            ? `All ${p.total} parts are built — but none are wired up yet, so nothing runs end to end.`
            : `${built} of ${p.total} parts are built — but none are wired up yet, so nothing runs end to end.`
          : `None of the ${p.total} parts this needs are built yet.`
        : `${p.ok} of ${p.total} parts are built and checked; ${missing} still to go.`;
  return { key: "confidence", label: "Confidence", value: `${pct}%`, pct, band, rationale };
}

function riskGate(goal: GoalRecord, outcome: ProveOutcome | null, p: Proof): Gate {
  if (!p.checked) {
    return {
      key: "risk",
      label: "Risk",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale: "Not checked yet — nothing to weigh.",
    };
  }
  // Real danger signals, straight from the proof: placeholders that look done
  // but do nothing, and steps nothing ever calls. Plus a regression — work that
  // used to pass and stopped.
  let stubs = 0;
  let dead = 0;
  if (outcome) {
    for (const c of outcome.checks) {
      if (c.is_stub) stubs++;
      else if (c.must_call && c.wired === false) dead++;
    }
  }
  const regressed = regressionCount(goal.runs);
  const flags = stubs + dead + regressed;

  const parts: string[] = [];
  if (stubs)
    parts.push(
      `${stubs} placeholder${stubs > 1 ? "s" : ""} that look${stubs > 1 ? "" : "s"} finished but do${
        stubs > 1 ? "" : "es"
      }n't do anything`,
    );
  if (dead) parts.push(`${dead} step${dead > 1 ? "s" : ""} nothing calls`);
  if (regressed)
    parts.push(`${regressed} part${regressed > 1 ? "s" : ""} that stopped passing`);

  if (flags === 0) {
    return {
      key: "risk",
      label: "Risk",
      value: "Low",
      pct: 100,
      band: "strong",
      rationale: "Nothing looks done-but-empty, and nothing that was working has broken.",
    };
  }
  const band: GateBand = flags <= 1 ? "fair" : "weak";
  return {
    key: "risk",
    label: "Risk",
    value: flags <= 1 ? "Watch" : "High",
    pct: flags <= 1 ? 55 : 20,
    band,
    rationale: `Worth a look — ${joinPlain(parts)}.`,
  };
}

function driftGate(goal: GoalRecord): Gate {
  const rated = goal.runs.filter((r) => r.total > 0);
  if (rated.length < 2) {
    return {
      key: "drift",
      label: "Drift",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale:
        rated.length === 1
          ? "Only one check so far — not enough to see a trend."
          : "No checks yet to compare across.",
    };
  }
  const regressed = regressionCount(goal.runs);
  if (regressed === 0) {
    return {
      key: "drift",
      label: "Drift",
      value: "Held",
      pct: 100,
      band: "strong",
      rationale: `Held steady — parts that got proven stayed proven across all ${rated.length} checks.`,
    };
  }
  const band: GateBand = regressed <= 1 ? "fair" : "weak";
  return {
    key: "drift",
    label: "Drift",
    value: regressed <= 1 ? "Slipped" : "Wandered",
    pct: regressed <= 1 ? 55 : 25,
    band,
    rationale: `${regressed} time${regressed > 1 ? "s" : ""} a part that was in place stopped passing — the work drifted from where it had got to.`,
  };
}

function buildHeadline(p: Proof, risk: Gate, done: boolean): string {
  if (!p.checked || p.total === 0) {
    return "Not checked yet — run a verify to see where this feature stands.";
  }
  if (done) {
    return risk.band === "weak"
      ? "Built end-to-end — but clear the risks flagged below before you call it done."
      : "Finished — every part is built and checked, and nothing risky is flagged.";
  }
  const missing = p.total - p.ok;
  const built = Math.min(p.total, p.built ?? 0);
  const base =
    p.ok === 0
      ? built > 0
        ? built === p.total
          ? `Every part is built — but none are wired up yet, so nothing runs end to end.`
          : `${built} of ${p.total} parts are built — but none are wired up yet, so nothing runs end to end.`
        : `Not started in the code yet — none of the ${p.total} parts are built.`
      : `Not done yet — ${p.ok} of ${p.total} parts are built, ${missing} still to go.`;
  return risk.band === "weak" ? `${base} And some of what's there needs a second look.` : base;
}

/** Fold a goal's proof + run history into the three feature gates and an overall
 *  read. Pass the live `aura prove` outcome when the card holds one; without it
 *  the gates fall back to the newest recorded run (Risk then can't see
 *  placeholders/dead-ends, so it weighs regressions only — it never guesses). */
export function computeFeatureSignals(
  goal: GoalRecord,
  outcome: ProveOutcome | null,
): FeatureSignals {
  const p = currentProof(goal, outcome);
  const confidence = confidenceGate(p);
  const risk = riskGate(goal, outcome, p);
  const drift = driftGate(goal);
  const done = p.checked && p.total > 0 && p.ok === p.total;
  const rated = p.checked || goal.runs.length > 0;
  return { confidence, risk, drift, headline: buildHeadline(p, risk, done), done, rated };
}

// ── aggregate: a feature made of several goals ──────────────────────────────
// A feature is often more than one goal — several asks, worked across several
// sessions, that together make the thing. This rolls every goal's proof + run
// history into ONE feature-level read: how many goals are actually reached, how
// much of the whole is in place, and the merged thread of every check across
// every session and commit that touched it. Same honesty rule as a single goal
// — it only sums real recorded proof, and reads "not checked" where a goal has
// none. This is the "one feature across all its sessions and commits" answer.

export type AggregateFeature = {
  /** Feature-level gates + overall headline — same shape a single goal produces,
   *  so it renders through the same gate cards. */
  signals: FeatureSignals;
  goalsReached: number;
  goalsTotal: number;
  /** Every recorded check across every goal in the feature, newest first. */
  runs: GoalRun[];
};

function aggConfidence(
  reached: number,
  goalsTotal: number,
  sumOk: number,
  sumTotal: number,
  anyChecked: boolean,
): Gate {
  if (!anyChecked) {
    return {
      key: "confidence",
      label: "Confidence",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale: "None of this feature's goals have been checked yet.",
    };
  }
  const pct = sumTotal > 0 ? Math.round((sumOk / sumTotal) * 100) : 0;
  const band: GateBand =
    reached === goalsTotal ? "strong" : reached > 0 || sumOk > 0 ? "fair" : "weak";
  const rationale =
    reached === goalsTotal
      ? `All ${goalsTotal} goals reached — the whole feature is built and checked.`
      : `${reached} of ${goalsTotal} goals reached — ${sumOk} of ${sumTotal} parts in place across the feature.`;
  return { key: "confidence", label: "Confidence", value: `${pct}%`, pct, band, rationale };
}

function aggRisk(regressions: number, anyChecked: boolean): Gate {
  if (!anyChecked) {
    return {
      key: "risk",
      label: "Risk",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale: "Not checked yet — nothing to weigh.",
    };
  }
  if (regressions === 0) {
    return {
      key: "risk",
      label: "Risk",
      value: "Low",
      pct: 100,
      band: "strong",
      rationale: "Nothing that was working across this feature has broken.",
    };
  }
  const band: GateBand = regressions <= 1 ? "fair" : "weak";
  return {
    key: "risk",
    label: "Risk",
    value: regressions <= 1 ? "Watch" : "High",
    pct: regressions <= 1 ? 55 : 20,
    band,
    rationale: `${regressions} part${regressions > 1 ? "s" : ""} across the feature stopped passing after being proven.`,
  };
}

function aggDrift(regressions: number, ratedRuns: number): Gate {
  if (ratedRuns < 2) {
    return {
      key: "drift",
      label: "Drift",
      value: "—",
      pct: 0,
      band: "unknown",
      rationale: "Not enough checks yet to see a trend.",
    };
  }
  if (regressions === 0) {
    return {
      key: "drift",
      label: "Drift",
      value: "Held",
      pct: 100,
      band: "strong",
      rationale: `Held steady — proven parts stayed proven across all ${ratedRuns} checks.`,
    };
  }
  const band: GateBand = regressions <= 1 ? "fair" : "weak";
  return {
    key: "drift",
    label: "Drift",
    value: regressions <= 1 ? "Slipped" : "Wandered",
    pct: regressions <= 1 ? 55 : 25,
    band,
    rationale: `The work drifted ${regressions} time${regressions > 1 ? "s" : ""} — a part that was in place stopped passing.`,
  };
}

function aggHeadline(
  reached: number,
  goalsTotal: number,
  anyChecked: boolean,
  done: boolean,
  risk: Gate,
): string {
  if (!anyChecked) {
    return "Not checked yet — verify this feature's goals to see where it stands.";
  }
  if (done) {
    return risk.band === "weak"
      ? "All goals reached — but clear the risks flagged below before you call it done."
      : "Finished — every goal in this feature is built and checked.";
  }
  const open = goalsTotal - reached;
  return `Not done yet — ${reached} of ${goalsTotal} goals reached, ${open} still open.`;
}

/** Roll a set of goals (a feature — e.g. every goal under one task/epic, worked
 *  across many sessions) into one feature-level read plus the merged thread of
 *  every check that touched it. Sums recorded proof only; never guesses. */
export function aggregateFeatureSignals(goals: GoalRecord[]): AggregateFeature {
  const goalsTotal = goals.length;
  let sumOk = 0;
  let sumTotal = 0;
  let checkedGoals = 0;
  let reached = 0;
  let regressions = 0;
  let ratedRuns = 0;
  const runs: GoalRun[] = [];
  for (const g of goals) {
    const r = rollup(g);
    if (r.at != null) checkedGoals++;
    if (r.verdict === "verified") reached++;
    sumOk += r.ok;
    sumTotal += r.total;
    regressions += regressionCount(g.runs);
    for (const run of g.runs) {
      runs.push(run);
      if (run.total > 0) ratedRuns++;
    }
  }
  runs.sort((a, b) => b.at - a.at);
  const anyChecked = checkedGoals > 0;

  const confidence = aggConfidence(reached, goalsTotal, sumOk, sumTotal, anyChecked);
  const risk = aggRisk(regressions, anyChecked);
  const drift = aggDrift(regressions, ratedRuns);
  const done = anyChecked && goalsTotal > 0 && reached === goalsTotal;
  const headline = aggHeadline(reached, goalsTotal, anyChecked, done, risk);
  const rated = anyChecked || runs.length > 0;
  return {
    signals: { confidence, risk, drift, headline, done, rated },
    goalsReached: reached,
    goalsTotal,
    runs,
  };
}

// ── who worked it + the feature's shape (Properties & Roles) ────────────────
// Entire's Trails answer the "who and what" of a feature in a compact panel; the
// same reads fall straight out of the run history Aura already keeps. A "role"
// here is simply everyone whose checks moved the feature along — the sessions
// and agents that worked it — with what each one last landed. The "properties"
// are the plain facts of its shape: when it started, when it was last touched,
// how many sessions and commits it spans. All derived from real recorded runs;
// nothing invented, nothing typed by hand.

/** One party who worked the feature — a session, an agent, or a hand check. */
export type Contributor = {
  /** Who did the work — the run's own label, else its agent, else a short key. */
  who: string;
  /** How many recorded checks this contributor drove. */
  checks: number;
  /** How their most recent check landed — the dot colour reads from this. */
  lastVerdict: GoalVerdict;
  /** When they last touched the feature (ms since epoch). */
  lastAt: number;
};

/** The feature's shape over time + everyone who worked it. */
export type FeatureProperties = {
  startedAt: number | null;
  lastAt: number | null;
  sessions: number;
  commits: number;
  checks: number;
  contributors: Contributor[];
};

function whoOf(run: GoalRun): string {
  return run.label ?? run.agentId ?? run.runKey.slice(0, 8);
}

/** Read the feature's Properties (its shape across time) and Roles (who worked
 *  it) straight off the merged run history. Contributors come back newest-touch
 *  first, each with their check count and how their latest check landed. Pure;
 *  counts real recorded runs only — it never infers a party that didn't act. */
export function describeFeature(runs: GoalRun[]): FeatureProperties {
  const sessions = new Set<string>();
  const commits = new Set<string>();
  const byWho = new Map<string, Contributor>();
  let startedAt: number | null = null;
  let lastAt: number | null = null;
  for (const run of runs) {
    sessions.add(run.runKey);
    if (run.commit) commits.add(run.commit);
    if (startedAt == null || run.at < startedAt) startedAt = run.at;
    if (lastAt == null || run.at > lastAt) lastAt = run.at;
    const who = whoOf(run);
    const existing = byWho.get(who);
    if (!existing) {
      byWho.set(who, { who, checks: 1, lastVerdict: run.verdict, lastAt: run.at });
    } else {
      existing.checks++;
      // Keep the verdict of their *latest* touch, so the dot reads current.
      if (run.at > existing.lastAt) {
        existing.lastAt = run.at;
        existing.lastVerdict = run.verdict;
      }
    }
  }
  const contributors = [...byWho.values()].sort((a, b) => b.lastAt - a.lastAt);
  return { startedAt, lastAt, sessions: sessions.size, commits: commits.size, checks: runs.length, contributors };
}
