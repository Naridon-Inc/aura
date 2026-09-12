// Where you are standing, for a page about somewhere you were.
//
// A review pane needs one fact about the present: which branch is checked out
// and whether it has unsaved changes, so an action can say what it will land
// on. Both reads already exist and are already shared per window
// (lib/gitStateCache), and both reject rather than resolve a zeroed struct —
// which is the property that matters here. "Clean" and "couldn't tell" are
// different answers, and only one of them is safe to print.

import { useEffect, useState } from "react";
import { fetchAheadBehind, fetchDiffStats } from "./gitStateCache";
import type { WorkingTarget } from "./reviewScope";

const UNKNOWN: WorkingTarget = { branch: null, dirty: false, known: false };

export function useWorkingTarget(repoRoot: string): WorkingTarget {
  const [target, setTarget] = useState<WorkingTarget>(UNKNOWN);

  useEffect(() => {
    let live = true;
    setTarget(UNKNOWN);
    void (async () => {
      try {
        const [branchState, stats] = await Promise.all([
          fetchAheadBehind(repoRoot),
          fetchDiffStats(repoRoot),
        ]);
        if (!live) return;
        setTarget({
          branch: branchState.branch,
          dirty: stats.changed_files > 0,
          known: true,
        });
      } catch {
        // Git couldn't be read. The page says nothing about the working tree
        // rather than describing it wrongly.
        if (live) setTarget(UNKNOWN);
      }
    })();
    return () => {
      live = false;
    };
  }, [repoRoot]);

  return target;
}
