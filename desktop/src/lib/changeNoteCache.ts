// Shared per-(repo, commit) cache for deterministic change-note reports.
//
// Two surfaces want the same `aura change-note <sha> --json` payload: the
// Changes tab's per-file `ChangeNoteCard` (what/why/blast-radius above a diff)
// and the Summary tab's symbol highlighting (`useChangesetSymbols` → the names
// `IntentProse` chips). Routing both through one cache means a given commit is
// shelled to the engine at most once, no matter how many files or tabs read it.

import { api } from "./api";
import type { ChangeNoteReport } from "./api";

const reportCache = new Map<string, Promise<ChangeNoteReport>>();

/** Fetch (or reuse) the full change-note report for a commit — or for a
 *  `base...head` range. Rejections are evicted so the next caller retries
 *  instead of inheriting a dead promise. */
export function fetchChangeNoteReport(
  repoRoot: string,
  commit: string,
): Promise<ChangeNoteReport> {
  const key = `${repoRoot}@${commit}`;
  let p = reportCache.get(key);
  if (!p) {
    p = api.auraChangeNote(repoRoot, commit);
    p.catch(() => reportCache.delete(key));
    reportCache.set(key, p);
  }
  return p;
}

/** The resolved range spec for a pull request, or null when this machine can't
 *  see both ends of it. Cached per (repo, base, head) — including the misses,
 *  so a PR whose branches aren't fetched doesn't re-probe git on every render. */
const rangeCache = new Map<string, Promise<string | null>>();

/** The `base...head` spec this repo can resolve for a pull request, so the PR
 *  can be read as ONE change instead of a pile of commits. Null when neither
 *  end is on this machine — a fork PR that was never fetched simply isn't
 *  describable from here, and the caller shows the diff without a story rather
 *  than one built from a range that doesn't exist.
 *
 *  The spelling hunt happens in the backend on rev-parse alone, which matters:
 *  a change-note is a full AST diff plus a call-graph walk, so guessing by
 *  running one per candidate would cost minutes to learn what git answers in
 *  milliseconds. Cached per (repo, base, head) — misses included, so a PR
 *  that can't be resolved doesn't re-probe on every render. */
export function resolvePrRange(
  repoRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string | null> {
  const key = `${repoRoot}@${baseRef}...${headRef}`;
  let p = rangeCache.get(key);
  if (!p) {
    p = api.resolvePrRange(repoRoot, baseRef, headRef).catch(() => null);
    rangeCache.set(key, p);
  }
  return p;
}
