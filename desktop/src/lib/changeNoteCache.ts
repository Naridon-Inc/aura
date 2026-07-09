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

/** Fetch (or reuse) the full change-note report for a commit. Rejections are
 *  evicted so the next caller retries instead of inheriting a dead promise. */
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
