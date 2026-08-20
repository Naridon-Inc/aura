// gitStateCache — one answer to "where does this branch stand?", shared by
// every surface that asks.
//
// Three components poll `gitAheadBehind` on the same 6-second cadence and none
// of them knows the other two exist: the review header (permanent chrome), the
// checks panel, and the commit box. Two of them also poll `gitDiffStats`. None
// of these unmount when you switch rail tabs — the rail hides them with a CSS
// class rather than unmounting — so all three timers run for the whole life of
// the window whether or not you are looking at any of them.
//
// The backend is not cheap to triplicate: `git_ahead_behind` shells out to git
// twice per call, `git_diff_stats` twice more. Three pollers × two spawns is up
// to six git processes every six seconds, permanently, on a repo you may not
// even have open in front of you.
//
// So: one read per window, shared. Callers keep their own timers and their own
// error handling — this only collapses the overlapping reads underneath them.
//
// A NOTE ON FAILURE, because it is the whole reason this file is careful.
// Every caller of these two commands has a hand-written catch that exists to
// stop a failed git read from being reported as a real answer — a zeroed
// `AheadBehind` reads as "this branch is published nowhere", which is a
// confident lie. This cache therefore *rejects* on failure and caches nothing.
// It must never resolve with a zeroed struct or a stale value dressed as
// current, or it would defeat every one of those catches at once.

import { api, type AheadBehind, type DiffStats } from "./api";
import { dropShared, readShared, sharedReader } from "./sharedRead";

/** How long a read stays good enough to hand to the next caller.
 *
 *  Sized against the callers' own cadence: they poll every 6000ms, so a window
 *  just under that means the pollers overlapping inside one cycle collapse to a
 *  single backend read, while the next cycle still does a real read. Raising
 *  this above the poll interval would start serving answers older than the
 *  surface believes it is showing. */
const FRESH_MS = 5_000;

// One shared reader per command. Keeping them separate matters: a caller that
// wants only ahead/behind must not be made to pay for the diff stats too.
const aheadBehind = sharedReader(
  (repoRoot: string) => api.gitAheadBehind(repoRoot),
  FRESH_MS,
);
const diffStats = sharedReader(
  (repoRoot: string) => api.gitDiffStats(repoRoot),
  FRESH_MS,
);

/** Branch ahead/behind, shared across the surfaces polling for it. Rejects if
 *  git could not be read — never resolves to a zeroed struct. */
export function fetchAheadBehind(repoRoot: string): Promise<AheadBehind> {
  return readShared(aheadBehind, repoRoot);
}

/** Working-tree diff stats vs HEAD, shared the same way. */
export function fetchDiffStats(repoRoot: string): Promise<DiffStats> {
  return readShared(diffStats, repoRoot);
}

/** Throw away everything known about the working tree, so the next read is
 *  real. Global rather than per-repo because the signal that triggers it is. */
export function invalidateGitState(): void {
  dropShared(aheadBehind);
  dropShared(diffStats);
}

// A commit, a branch switch, a job that touched files — all of them announce
// themselves this way, and none of them says which repo, so everything goes.
// Subscribing here rather than in each caller is the point: a surface added
// later reads through this cache and cannot forget to invalidate, and a stale
// ahead/behind is at its most misleading in exactly the second after the action
// that changed it.
if (typeof window !== "undefined") {
  window.addEventListener("aura:git-changed", invalidateGitState);
}
