// Everything the Changes tab's diff pane reads for one file: the patch, the
// whole file on disk (the current side of an editable diff), and the recorded
// change-note with its commit's when and who.
//
// HONESTY RULE: the diff body is a real git diff and nothing else. A
// live/manual claim shows `git diff HEAD -- <path>` (the working tree). A
// back-filled run stamps each file with the commit that landed it, so we show
// that commit's real patch (`git show <sha> -- <path>`) — the run's actual
// change — instead of an empty working-tree diff.

import { useCallback, useEffect, useState } from "react";
import { api, type FileChangeNote, type IntentChangesetFile } from "../../../lib/api";
import { fetchChangeNoteReport } from "../../../lib/changeNoteCache";
import { loadFileDiff } from "../../../lib/sessionDataCache";

export interface ChangeDiff {
  diff: string | null;
  loading: boolean;
  error: string | null;
  /** The whole working-tree file as last read from disk. Null for a committed
   *  or teammate's file, which has no file here to write back to. */
  diskText: string | null;
  absPath: string | null;
  /** Re-read the diff and file in place (after a save, or when the file
   *  changes on disk) without the blank-then-load flash a file switch has. */
  refresh: () => void;
  /** The per-file change-note for this file in its commit, with the commit's
   *  real when and who. Null for a live change, or until the report lands. */
  note: FileChangeNote | null;
  when: number | null;
  author: string | null;
}

export function useChangeDiff(
  repoRoot: string,
  file: IntentChangesetFile,
  /** "All changes" mode (worktrees): a working-tree file's diff spans the
   *  worktree's fork base → working tree, not just vs HEAD. A committed file
   *  always shows that commit's patch regardless. */
  sinceBase: boolean,
): ChangeDiff {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diskText, setDiskText] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const [note, setNote] = useState<FileChangeNote | null>(null);
  const [when, setWhen] = useState<number | null>(null);
  const [author, setAuthor] = useState<string | null>(null);
  const isWorkingTree = !file.commit && !file.remote_only;
  const absPath = isWorkingTree
    ? file.path.startsWith("/")
      ? file.path
      : `${repoRoot.replace(/\/$/, "")}/${file.path}`
    : null;

  // Same shared (repo, commit) cache the commit's change-note card reads, so
  // the header costs no extra engine round-trip.
  useEffect(() => {
    setNote(null);
    setWhen(null);
    setAuthor(null);
    if (!repoRoot || !file.commit) return;
    let alive = true;
    fetchChangeNoteReport(repoRoot, file.commit)
      .then((report) => {
        if (!alive) return;
        setNote(report.files.find((f) => f.file === file.path) ?? null);
        setWhen(report.commit_time ?? null);
        setAuthor(report.author?.trim() || null);
      })
      .catch(() => {
        /* the header stays hidden on a miss — the diff is still the star */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, file.commit, file.path]);

  // A different file (or scope) starts from blank. Declared before the fetch
  // below so it runs first in the same commit; a plain refresh (the tick)
  // skips this and re-reads quietly behind whatever is already on screen.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setDiff(null);
    setDiskText(null);
  }, [repoRoot, file.path, file.commit, file.remote_only, sinceBase]);

  useEffect(() => {
    if (!repoRoot) return;
    // A teammate's file, carried over the team plane: there is no patch here
    // to fetch. The pane shows what we do know instead.
    if (file.remote_only) {
      setLoading(false);
      setError(null);
      setDiff(null);
      return;
    }
    let alive = true;
    setError(null);
    // A working-tree file is also read whole, in the same round, so the
    // editable view has the real file to type into and the patch and the file
    // describe the same moment. The patch goes through the per-session diff
    // cache, so re-selecting a file is instant instead of re-shelling git.
    const fileRead: Promise<string | null> = absPath
      ? api
          .readFile(absPath)
          .then((c) => (c.status === "ok" ? c.text : null))
          .catch(() => null)
      : Promise.resolve(null);
    Promise.all([loadFileDiff(repoRoot, file, sinceBase), fileRead])
      .then(([d, text]) => {
        if (!alive) return;
        setDiff(d ?? "");
        setDiskText(text);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, file.path, file.commit, file.remote_only, sinceBase, absPath, refreshTick]);

  return { diff, loading, error, diskText, absPath, refresh, note, when, author };
}
