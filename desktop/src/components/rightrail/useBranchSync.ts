// GitHub's merge state for the branch's open pull request, and the branch's
// distance from that pull request's base (or the remote's default branch).
// Read with the rest of the rail, on the same tick; a failed read keeps the
// last answer rather than flashing rows away.

import { useEffect, useState } from "react";

import type { PrSummary } from "../../lib/api";
import { gitTargetSync, prMergeState, type PrMergeState, type TargetSync } from "../../lib/branchSync";

export type BranchSync = { merge: PrMergeState | null; sync: TargetSync | null };

export function useBranchSync(repoRoot: string, pr: PrSummary | null, tick: number): BranchSync {
  const [merge, setMerge] = useState<PrMergeState | null>(null);
  const [sync, setSync] = useState<TargetSync | null>(null);
  const open = pr !== null && pr.state.toLowerCase() === "open";
  const number = open ? pr.number : null;
  const base = pr?.base_ref || null;

  useEffect(() => {
    if (number === null) {
      setMerge(null);
      return;
    }
    let alive = true;
    prMergeState(repoRoot, number)
      .then((m) => alive && setMerge(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoRoot, number, tick]);

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    gitTargetSync(repoRoot, base)
      .then((s) => alive && setSync(s))
      .catch(() => alive && setSync(null));
    return () => {
      alive = false;
    };
  }, [repoRoot, base, tick]);

  return { merge, sync };
}
