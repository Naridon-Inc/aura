// The CI checks on the branch's pull request, and its preview deployment.
// Re-read on the same cadence as the rest of the Checks tab while any check
// is still running, and whenever the caller's tick moves. The checks come
// back failing first, then running, then passing — the order they are read.

import { useEffect, useState } from "react";

import type { PrCheck, VercelDeployment } from "../../lib/api";
import { prChecks, prVercelStatus } from "../../lib/prApi";
import { BUCKET_ORDER, bucketOf } from "../pr/checks/PrCheckRows";

const PENDING_POLL_MS = 15_000;

export type BranchChecks =
  | { state: "none" }
  | { state: "reading" }
  | { state: "failed" }
  | { state: "read"; checks: PrCheck[] };

/** Failing, then running, then passing; GitHub's order within each. */
export function sortChecks(list: PrCheck[]): PrCheck[] {
  return BUCKET_ORDER.flatMap((b) => list.filter((c) => bucketOf(c) === b));
}

export function useBranchChecks(
  repoRoot: string,
  prNumber: number | null,
  tick: number,
): { checks: BranchChecks; deploy: VercelDeployment | null; reread: () => void } {
  const [result, setResult] = useState<BranchChecks>({ state: "none" });
  const [deploy, setDeploy] = useState<VercelDeployment | null>(null);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    if (prNumber == null) {
      setResult({ state: "none" });
      setDeploy(null);
      return;
    }
    let alive = true;
    setResult((prev) => (prev.state === "read" ? prev : { state: "reading" }));
    void prChecks(repoRoot, prNumber)
      .then((list) => alive && setResult({ state: "read", checks: sortChecks(list) }))
      .catch(() => alive && setResult({ state: "failed" }));
    // Soft: no Vercel set up, or no deploy for the commit yet, is no row.
    void prVercelStatus(repoRoot, prNumber)
      .then((d) => alive && setDeploy(d))
      .catch(() => alive && setDeploy(null));
    return () => {
      alive = false;
    };
  }, [repoRoot, prNumber, tick, poll]);

  const running =
    result.state === "read" && result.checks.some((c) => bucketOf(c) === "pending");
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setPoll((n) => n + 1), PENDING_POLL_MS);
    return () => window.clearTimeout(id);
  }, [running, poll]);

  return { checks: result, deploy, reread: () => setPoll((n) => n + 1) };
}
