// useShipReadiness — the live ship-readiness signal behind the ShipReadyPill.
//
// Runs ONLY the fast Semantic-CI gates (`aura ci run --trigger pre-commit`: no
// leaked secrets, no half-finished code, goal alignment — all AST-flag checks,
// ~0ms, no compiler), so it's cheap enough to re-run on its own after every
// commit. The slow build deliberately stays out of this path; it runs from the
// full check (the ChecksPane) and on push.
//
// Live triggers: on mount, after every commit/push (the app fires
// `aura:git-changed`), and when the window regains focus (catches commits made
// in a terminal). An in-flight guard collapses overlapping refreshes.
//
// `needsLook` counts only BLOCKING failures — an advisory gate (e.g. goal not
// linked yet) never turns the pill red.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export type ShipState = "checking" | "pass" | "attention" | "unknown";

export type ShipReadiness = {
  state: ShipState;
  /** Passing checks in the last run. */
  passed: number;
  /** Blocking checks that failed / timed out in the last run. */
  needsLook: number;
  /** When the last good run landed (ms epoch), or null if none yet. */
  ranAt: number | null;
};

const INITIAL: ShipReadiness = {
  state: "checking",
  passed: 0,
  needsLook: 0,
  ranAt: null,
};

export function useShipReadiness(repoRoot: string): ShipReadiness {
  const [readiness, setReadiness] = useState<ShipReadiness>(INITIAL);
  const inflightRef = useRef(false);

  const check = useCallback(async () => {
    if (!repoRoot || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const runs = await api.getChecks(repoRoot, "pre-commit");
      if (runs.length === 0) {
        // [] means the CLI couldn't run them (old `aura`, not a git repo, parse
        // error) — not "all clear". Report unknown so the pill stays quiet.
        setReadiness((prev) => ({ ...prev, state: "unknown" }));
        return;
      }
      let passed = 0;
      let needsLook = 0;
      for (const run of runs) {
        for (const step of run.steps) {
          if (step.status === "pass") {
            passed += 1;
          } else if (
            step.blocking &&
            (step.status === "fail" || step.status === "timeout")
          ) {
            needsLook += 1;
          }
        }
      }
      setReadiness({
        state: needsLook > 0 ? "attention" : "pass",
        passed,
        needsLook,
        ranAt: Date.now(),
      });
    } catch {
      setReadiness((prev) => ({ ...prev, state: "unknown" }));
    } finally {
      inflightRef.current = false;
    }
  }, [repoRoot]);

  useEffect(() => {
    void check();
    const onGitChanged = () => void check();
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void check();
    };
    window.addEventListener("aura:git-changed", onGitChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("aura:git-changed", onGitChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check]);

  return readiness;
}
