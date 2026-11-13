// The facts behind a session's Resume and Rewind controls: which commit the
// run lands on, which files and functions it touched, and the remembered
// "don't ask again" for the Resume confirm.

import type { ChangedSymbol, IntentChangesetFile } from "../../../lib/api";
import { basename } from "../../../lib/paths";

// Resume spawns a *live* billed agent, so the first time round we explain
// what it does and confirm before launching. A user who resumes constantly
// can opt out; the choice persists here so we honor the "ask at least once"
// intent without nagging forever.
const RESUME_SKIP_KEY = "aura.session.resumeConfirm.skip";

export function readResumeSkip(): boolean {
  try {
    return localStorage.getItem(RESUME_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeResumeSkip(skip: boolean) {
  try {
    if (skip) localStorage.setItem(RESUME_SKIP_KEY, "1");
    else localStorage.removeItem(RESUME_SKIP_KEY);
  } catch {
    /* storage disabled (private mode) — the confirm just always shows. */
  }
}

/** The commit this session lands on — the sha stamped on its changed files.
 *  A logged run is normally one commit, so the first stamped sha is exact;
 *  a multi-commit backfill picks its first (any is "this point"). null when
 *  nothing is committed yet (a live working-tree claim). */
export function sessionCommit(files: IntentChangesetFile[]): string | null {
  for (const f of files) {
    if (f.commit) return f.commit;
  }
  return null;
}

/** Absolute path for a repo-relative changeset path. The Time machine's
 *  snapshot matcher keys on the absolute file, mirroring the symbol
 *  right-click menu's contract. */
function toAbs(repoRoot: string, relPath: string): string {
  const root = repoRoot.replace(/\/$/, "");
  return relPath.startsWith("/") ? relPath : `${root}/${relPath}`;
}

/** Symbols for a changeset file: exact path key first, then a basename match
 *  (the change-note report path and the changeset path can differ by prefix).
 *  Empty → the file is offered as a whole-file rewind. */
function symbolsFor(byFile: Record<string, ChangedSymbol[]>, path: string): ChangedSymbol[] {
  const exact = byFile[path];
  if (exact && exact.length) return exact;
  const base = basename(path);
  for (const k of Object.keys(byFile)) {
    if (basename(k) === base && byFile[k].length) return byFile[k];
  }
  return [];
}

export type RewindTarget = {
  /** Repo-relative path (for the label). */
  path: string;
  /** Absolute path (for the rewind tool). */
  abs: string;
  symbols: ChangedSymbol[];
};

export function rewindTargets(
  repoRoot: string,
  files: IntentChangesetFile[],
  symbolsByFile: Record<string, ChangedSymbol[]>,
): RewindTarget[] {
  return files.map((f) => ({
    path: f.path,
    abs: toAbs(repoRoot, f.path),
    symbols: symbolsFor(symbolsByFile, f.path),
  }));
}

/** A symbol's change, in the word the menu prints beside it. */
export function changeWord(change: string): string {
  return change === "added" ? "added" : change === "deleted" ? "removed" : "changed";
}
