// What runs underneath Create PR, out of sight: the safety check, the goal
// proof and the signed record. None of them is a step, a card or a gate — the
// pull request opens either way. Each leaves its result where Aura already
// keeps it:
//
//   • the safety check writes its report under `.aura/reviews/`, which is
//     what the pull request's risk mark (`aura_risk_label`) is read from;
//   • the goal proof records a run on each goal in the ledger, stamped with
//     the commit it proved;
//   • the signed record seals a block under `.aura/blocks/` and
//     `.aura/attest/`.
//
// A pass says nothing. A failure leaves ONE plain sentence for the Checks
// panel, with "See why" opening the detail that already exists for it.

import { useSyncExternalStore } from "react";
import { api, type CliResult, type ReviewReport } from "./api";
import { ledgerList, ledgerProve } from "./goalLedger";
import type { GoalRecord } from "./goalStore";
import type { ProveOutcome } from "./prove";

export type PrGuardKind = "safety" | "goals" | "record";

export type PrGuardFailure = {
  kind: PrGuardKind;
  /** The one sentence the panel shows. */
  line: string;
};

/** How many goals one Create PR proves: the most recently touched ones. */
const GOALS_PROVED = 3;

export type PrGuardDeps = {
  review: (repoRoot: string, base: string) => Promise<ReviewReport>;
  goals: (repoRoot: string) => Promise<GoalRecord[]>;
  prove: (repoRoot: string, text: string, taskRef: string | null) => Promise<ProveOutcome | null>;
  sign: (repoRoot: string, text: string) => Promise<CliResult>;
};

const liveDeps: PrGuardDeps = {
  review: (repoRoot, base) => api.auraReviewJson(repoRoot, base),
  goals: ledgerList,
  prove: ledgerProve,
  sign: (repoRoot, text) => api.auraCli(repoRoot, ["sign-intent", text]),
};

async function safety(repoRoot: string, target: string, deps: PrGuardDeps): Promise<PrGuardFailure | null> {
  try {
    const report = await deps.review(repoRoot, target);
    if (report.status === "no_changes") return null;
    const broken = (report.invariant_violations ?? []).length > 0;
    if (report.risk_label === "CRITICAL" || broken) {
      return { kind: "safety", line: "The safety check found something to look at before this merges." };
    }
    return null;
  } catch {
    return { kind: "safety", line: "The safety check couldn't run on this pull request." };
  }
}

async function goals(repoRoot: string, deps: PrGuardDeps): Promise<PrGuardFailure | null> {
  const tracked = (await deps.goals(repoRoot).catch(() => []))
    .filter((g) => !g.dismissed && g.text.trim())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, GOALS_PROVED);
  if (tracked.length === 0) return null;
  const outcomes = await Promise.all(
    tracked.map((g) =>
      deps.prove(repoRoot, g.text, g.taskSeq ? `AURA-${g.taskSeq}` : null).catch(() => null),
    ),
  );
  const gaps = outcomes.filter((o) => o?.verdict === "not_wired").length;
  if (gaps === 0) return null;
  return {
    kind: "goals",
    line: gaps === 1 ? "A goal isn't working end to end yet." : `${gaps} goals aren't working end to end yet.`,
  };
}

async function record(
  repoRoot: string,
  branch: string,
  target: string,
  deps: PrGuardDeps,
): Promise<PrGuardFailure | null> {
  const failed: PrGuardFailure = { kind: "record", line: "This pull request's signed record couldn't be written." };
  try {
    const res = await deps.sign(repoRoot, `Opened a pull request for ${branch} onto ${target}`);
    if (res.status !== 0) return failed;
    const out = JSON.parse(res.stdout.trim() || "{}") as { signed_block_id?: string };
    return out.signed_block_id ? null : failed;
  } catch {
    return failed;
  }
}

// One answer per repo, replaced on every run. Frozen snapshots so
// `useSyncExternalStore` sees a stable reference between changes.
let failures: Readonly<Record<string, PrGuardFailure | null>> = {};
const listeners = new Set<() => void>();

function publish(repoRoot: string, failure: PrGuardFailure | null): void {
  if ((failures[repoRoot] ?? null) === failure) return;
  failures = { ...failures, [repoRoot]: failure };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The failure the panel shows for `repoRoot`, or null when everything
 *  underneath the last Create PR passed (or none has run). */
export function usePrGuardFailure(repoRoot: string): PrGuardFailure | null {
  const all = useSyncExternalStore(subscribe, () => failures, () => failures);
  return all[repoRoot] ?? null;
}

/** Order the panel reads them in: a safety problem matters most. */
const PRIORITY: PrGuardKind[] = ["safety", "goals", "record"];

/**
 * Run the three in parallel for the pull request `branch` → `target` is
 * about to become. Resolves to the one failure worth a sentence, or null.
 * Never throws: each guard turns its own error into its failure.
 */
export async function runPrGuards(
  repoRoot: string,
  pr: { branch: string; target: string },
  deps: PrGuardDeps = liveDeps,
): Promise<PrGuardFailure | null> {
  publish(repoRoot, null);
  const found = await Promise.all([
    safety(repoRoot, pr.target, deps),
    goals(repoRoot, deps),
    record(repoRoot, pr.branch, pr.target, deps),
  ]);
  const first =
    PRIORITY.map((k) => found.find((f) => f?.kind === k) ?? null).find((f) => f !== null) ?? null;
  publish(repoRoot, first);
  return first;
}
