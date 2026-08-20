// ambientCache — the three "is anything reaching my work?" reads, asked once.
//
// Impacts and conflicts drive ambient chrome: a nav-rail badge, a footer chip,
// a banner across the top, and the panes you open when one of them catches your
// eye. Because they are ambient, everything that shows them polls — and until
// this file existed, each poller asked the backend for itself:
//
//   App.tsx            every 4s   impacts + conflicts + AST conflicts
//   useLiveSync        every 4s   impacts + AST conflicts
//   AuraImpactsBanner  every 30s  impacts
//   ImpactsPane        on mount and on every refresh
//   ConflictPane       on mount
//   ConflictsDialog    on open and after each resolve
//
// Two four-second timers, running for the whole life of the window, asking the
// same question about the same repo a fraction of a second apart. And these are
// not cheap reads: each one opens `.aura/conflicts.jsonl` (796 KB in this repo)
// or `.aura/impacts.jsonl`, reads the whole file and parses it line by line.
//
// So: one read per window, shared, with the window sized under the pollers'
// own 4-second cadence. Nobody's timer changes; the duplicate reads underneath
// them collapse.
//
// A NOTE ON FAILURE. An empty impacts list is not a neutral value — it renders
// as "nothing on another branch is reaching your work", which is the whole
// reassurance the surface exists to give. Same for conflicts. So a failed read
// rejects and caches nothing; each caller's own catch already decides what to
// do, and most of them deliberately keep the last known list rather than
// publishing a zero.

import {
  api,
  type ConflictItem,
  type ConflictedNode,
  type ImpactAlert,
  type ResolveConflictArgs,
} from "./api";
import { dropShared, readShared, sharedReader } from "./sharedRead";

/** Under the 4000ms poll that both App.tsx and useLiveSync run, so their ticks
 *  collapse into one read while the next cycle is still real. */
const FRESH_MS = 3_000;

const impacts = sharedReader(
  (repoRoot: string) => api.auraReadImpacts(repoRoot),
  FRESH_MS,
);
const conflicts = sharedReader(
  (repoRoot: string) => api.auraListConflicts(repoRoot),
  FRESH_MS,
);
const astConflicts = sharedReader(
  (repoRoot: string) => api.auraConflictsList(repoRoot),
  FRESH_MS,
);

/** Cross-branch impact alerts — functions you depend on that moved elsewhere.
 *  Includes acknowledged ones; consumers filter `resolved` themselves. */
export function fetchImpacts(repoRoot: string): Promise<ImpactAlert[]> {
  return readShared(impacts, repoRoot);
}

/** The mixed git/AST conflict list behind the Conflict pane. */
export function fetchConflicts(repoRoot: string): Promise<ConflictItem[]> {
  return readShared(conflicts, repoRoot);
}

/** Durable AST-level conflicted nodes — the resolver's rows. */
export function fetchAstConflicts(repoRoot: string): Promise<ConflictedNode[]> {
  return readShared(astConflicts, repoRoot);
}

// The two mutations live here rather than at their call sites so that resolving
// something and forgetting the cached "before" cannot come apart. Acknowledge
// an impact and the pane refreshes within the freshness window, and a cache
// that still held the pre-resolve list would put the row straight back — the
// button would look broken while having worked perfectly.

/** Acknowledge an impact alert, and forget what we knew about this repo. */
export async function resolveImpact(
  repoRoot: string,
  alertId: string,
): Promise<void> {
  await api.auraResolveImpact(repoRoot, alertId);
  dropShared(impacts, repoRoot);
}

/** Resolve an AST conflict, and forget what we knew about this repo. */
export async function resolveAstConflict(
  repoRoot: string,
  args: ResolveConflictArgs,
): Promise<ConflictedNode> {
  const row = await api.auraConflictsResolve(repoRoot, args);
  dropShared(astConflicts, repoRoot);
  return row;
}

/** Everything ambient about this repo goes stale — for the callers that change
 *  the world some other way (a pull, a branch switch, a job that ran). */
export function invalidateAmbient(repoRoot: string): void {
  dropShared(impacts, repoRoot);
  dropShared(conflicts, repoRoot);
  dropShared(astConflicts, repoRoot);
}
