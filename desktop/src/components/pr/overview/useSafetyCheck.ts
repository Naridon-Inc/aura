// Running the safety check on a pull request: the review CLI compares the
// branch against its base and writes a report, the page re-reads the PR so
// the report shows, and a toast says what it found. The elapsed seconds tick
// while it runs, because a check on a big change can take a minute and a
// still "Running" reads as frozen.

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { invalidatePrDetail } from "../../../lib/prDetailCache";
import { reviewFlash } from "../../../lib/reviewVerdict";

export function useSafetyCheck(repoRoot: string, prNumber: number, baseRef: string) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedAt == null) return;
    setElapsed(0);
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const run = async () => {
    setError(null);
    setStartedAt(Date.now());
    try {
      const result = await api.auraCli(repoRoot, ["pr-review", "--base", baseRef || "main"]);
      if (result.status !== 0) {
        setError(result.stderr.trim() || `aura pr-review exited ${result.status}`);
        return;
      }
      try {
        // The report landed on disk; re-read the PR so the page shows it.
        const refreshed = await invalidatePrDetail(repoRoot, prNumber);
        // Every channel the row counts, and an honest sentence when the
        // payload didn't come back at all. See `reviewFlash`.
        const summary = reviewFlash(refreshed.aura_review);
        window.dispatchEvent(
          new CustomEvent("aura:toast", { detail: { kind: "success", text: summary, ttlMs: 6000 } }),
        );
      } catch (e) {
        setError(`Review ran, but refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartedAt(null);
    }
  };

  return { running: startedAt != null, elapsed, error, run };
}
