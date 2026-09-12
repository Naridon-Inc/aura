// One reading of a run's evidence, for every surface that shows it.
//
// The wizard says the same things twice: a ledger of what each result covers,
// and a list of what is still open. They must be the same reading — a list that
// says the checks failed above a row that says they passed is worse than
// either alone. So the assembly happens once, here, and both render it.
//
// It is the live half of `lib/sessionEvidence`: that module is pure and takes
// plain data, this one goes and gets the data — the verdicts recorded against
// this run, the shared record of checks that really executed, and the plan
// lines only a person can carry out.

import { useMemo } from "react";
import { checksLine, checksStatus, useChecksRun, type ChecksRunState } from "./checksEvidence";
import { useGoalsForRun } from "./goalStore";
import {
  foldGoalEvidence,
  sessionEvidence,
  type EvidenceItem,
  type GoalEvidenceRun,
} from "./sessionEvidence";

export type RunEvidenceInput = {
  repoRoot: string;
  /** The durable key for this run — the only verdicts that count as evidence
   *  about it are the ones stamped with it. */
  runKey: string;
  signed: boolean;
  /** The commit under review; null for a run whose changes aren't committed. */
  revision: string | null;
  /** Unix millis the reviewed code was produced. */
  codeChangedAt: number | null;
  fileCount: number;
  alignment: { available: boolean; unsupportedReason: string };
};

export type RunEvidence = {
  items: EvidenceItem[];
  /** The verify-plan lines this run's goals carry — steps written for a person,
   *  which Aura cannot run and must not quietly drop. */
  planLines: string[];
  /** The live state of the shared checks record, so a surface can offer to run
   *  them and report what happened. */
  checks: ChecksRunState;
};

export function useRunEvidence(input: RunEvidenceInput): RunEvidence {
  const { repoRoot, runKey, signed, revision, codeChangedAt, fileCount, alignment } = input;

  // Only verdicts recorded against THIS run describe this run's code. A check
  // another session ran on the same goal is evidence about that session.
  const goals = useGoalsForRun(repoRoot, runKey);
  const goal = useMemo(() => {
    const mine: GoalEvidenceRun[] = [];
    for (const g of goals) {
      for (const r of g.runs) {
        if (r.runKey === runKey) {
          mine.push({ verdict: r.verdict, ok: r.ok, total: r.total, at: r.at, commit: r.commit });
        }
      }
    }
    return foldGoalEvidence(mine);
  }, [goals, runKey]);

  // The verify plan, deduplicated across the run's goals — two goals that both
  // ask for the handset test are asking for one trip with a phone.
  const planLines = useMemo(() => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const g of goals) {
      for (const raw of g.acceptance ?? []) {
        const line = raw.trim();
        if (!line) continue;
        const key = line.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
      }
    }
    return lines;
  }, [goals]);

  const checksState = useChecksRun(repoRoot);
  const checks = useMemo(
    () =>
      checksState.cached
        ? {
            status: checksStatus(checksState.cached.runs),
            line: checksLine(checksState.cached.runs),
            ranAt: checksState.cached.ranAt,
            // The Checks surface records when they ran, not which version they
            // ran against. That gap is handled honestly downstream rather than
            // filled in with a guess here.
            revision: null,
          }
        : null,
    [checksState.cached],
  );

  const items = useMemo(
    () =>
      sessionEvidence({
        signed,
        alignment,
        revision,
        codeChangedAt,
        fileCount,
        goal,
        checks,
      }),
    [signed, alignment, revision, codeChangedAt, fileCount, goal, checks],
  );

  return { items, planLines, checks: checksState };
}
