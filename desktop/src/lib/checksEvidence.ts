// The last time real checks ran here — read as evidence, not as a verdict.
//
// The Checks surface caches its most recent pipeline run per repo so the pane
// paints instantly. That cache is the only record in the app of commands that
// genuinely executed against the code, so the session review reads it too — and
// the key had to stop being a private detail of one pane, or the two would drift
// into disagreeing about the same run.
//
// `checksStatus` is the honest fold: nothing failing is not the same as
// everything passing. A pipeline where two gates passed and six were skipped is
// "not run", because six questions were never asked.

import { useSyncExternalStore } from "react";
import { api, type CiPipelineRun } from "./api";
import { overallStatus, type EvidenceStatus } from "./evidence";

export type CachedChecks = {
  runs: CiPipelineRun[];
  /** Unix millis. */
  ranAt: number;
  mode?: string;
};

export function checksCacheKey(repoRoot: string): string {
  return `aura.checks.${repoRoot}`;
}

export function loadCachedChecks(repoRoot: string): CachedChecks | null {
  try {
    const raw = localStorage.getItem(checksCacheKey(repoRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedChecks;
    if (parsed && Array.isArray(parsed.runs) && typeof parsed.ranAt === "number") {
      return parsed;
    }
  } catch {
    /* private mode / parse error — treat as no cache */
  }
  return null;
}

export function saveCachedChecks(repoRoot: string, value: CachedChecks): void {
  try {
    localStorage.setItem(checksCacheKey(repoRoot), JSON.stringify(value));
  } catch {
    /* best-effort */
  }
  // Whoever saved it — the Checks pane's own auto-run, or a run started from a
  // session review — every surface watching this repo now shows the same result.
  publishChecks(repoRoot, value);
}

/** Fold every step of every pipeline into one status. Each step maps to the
 *  shared vocabulary — a pass is a pass, a failure or a timeout is a failure,
 *  and a skipped gate is a question nobody asked — and `overallStatus` refuses
 *  to let the passes outvote the rest. */
export function checksStatus(runs: CiPipelineRun[]): EvidenceStatus {
  const steps: EvidenceStatus[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status === "pass") steps.push("pass");
      else if (step.status === "fail" || step.status === "timeout") steps.push("fail");
      else steps.push("not_run");
    }
  }
  if (steps.length === 0) return "unavailable";
  return overallStatus(steps);
}

/** The counts, in plain words — what actually happened when those commands ran. */
export function checksLine(runs: CiPipelineRun[]): string {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status === "pass") passed += 1;
      else if (step.status === "fail" || step.status === "timeout") failed += 1;
      else skipped += 1;
    }
  }
  if (passed + failed + skipped === 0) return "No checks have been run here.";
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} came back with a problem`);
  if (skipped > 0) parts.push(`${skipped} never ran`);
  return `${sentence(parts)}.`;
}

// ── One live view of that record, shared by every surface ────────────────
// Two places on the session Summary offer to run the checks: the ledger row and
// the list of what is still open. With a copy of the cache each, one would go
// green while the other still showed the failure that had just been fixed. So
// the state lives here once, and both read it.

/** What a running trigger maps to in the pane's own vocabulary, so a run
 *  started from the review reads back correctly in Checks. */
const MODE_FOR = { "pre-commit": "quick", pr: "full" } as const;

export type ChecksRunState = {
  cached: CachedChecks | null;
  running: boolean;
  /** Why the last attempt produced no result. Empty when the last attempt
   *  worked, or when nobody has tried. Never cleared by anything but another
   *  attempt — a failure that vanishes on its own is a failure nobody sees. */
  error: string;
};

const listeners = new Set<() => void>();
const states = new Map<string, ChecksRunState>();

function stateOf(repoRoot: string): ChecksRunState {
  const existing = states.get(repoRoot);
  if (existing) return existing;
  const fresh: ChecksRunState = { cached: loadCachedChecks(repoRoot), running: false, error: "" };
  states.set(repoRoot, fresh);
  return fresh;
}

function setState(repoRoot: string, next: ChecksRunState) {
  states.set(repoRoot, next);
  for (const l of listeners) l();
}

/** Announce a result saved by any surface, keeping whatever else is in flight. */
function publishChecks(repoRoot: string, value: CachedChecks) {
  setState(repoRoot, { ...stateOf(repoRoot), cached: value });
}

function subscribeChecks(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The live checks state for a repo — cached result, whether a run is in
 *  flight, and why the last one didn't produce anything. */
export function useChecksRun(repoRoot: string): ChecksRunState {
  return useSyncExternalStore(
    subscribeChecks,
    () => stateOf(repoRoot),
    () => stateOf(repoRoot),
  );
}

/** Run the project's checks and record the result. Returns whether a result
 *  was actually produced.
 *
 *  An empty result is a failure, not an all-clear: a real run always returns at
 *  least the built-in pipeline, so nothing coming back means the CLI couldn't
 *  run them. Recording a fresh timestamp over that would close an unfinished
 *  item with an optimistic success — the precise thing this must not do. The
 *  earlier result stays, the failure is reported, and the item stays open. */
export async function runChecksNow(
  repoRoot: string,
  trigger: "pre-commit" | "pr" = "pre-commit",
): Promise<boolean> {
  const current = stateOf(repoRoot);
  if (current.running) return false;
  setState(repoRoot, { ...current, running: true, error: "" });
  try {
    const runs = await api.getChecks(repoRoot, trigger);
    if (runs.length === 0) {
      setState(repoRoot, {
        ...stateOf(repoRoot),
        running: false,
        error: "Aura couldn't run your checks just now. Nothing here has changed.",
      });
      return false;
    }
    const value: CachedChecks = { runs, ranAt: Date.now(), mode: MODE_FOR[trigger] };
    saveCachedChecks(repoRoot, value);
    setState(repoRoot, { cached: value, running: false, error: "" });
    return true;
  } catch (e) {
    setState(repoRoot, {
      ...stateOf(repoRoot),
      running: false,
      error: `Aura couldn't run your checks: ${e instanceof Error ? e.message : String(e)}`,
    });
    return false;
  }
}

function sentence(parts: string[]): string {
  if (parts.length === 0) return "Nothing ran";
  if (parts.length === 1) return parts[0][0].toUpperCase() + parts[0].slice(1);
  const head = parts.slice(0, -1).join(", ");
  const joined = `${head} and ${parts[parts.length - 1]}`;
  return joined[0].toUpperCase() + joined.slice(1);
}
