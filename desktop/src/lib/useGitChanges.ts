// Merged source-control snapshot: porcelain status + per-file numstat
// in one shape. The right-rail Changes panel reads this to render the
// staged / unstaged / untracked sections. Polls every 4s when visible,
// pauses when the document is hidden so a backgrounded window doesn't
// run `git status` forever.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type FileDiffStat, type GitStatusEntry } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

export type ChangedFile = {
  path: string;
  /** "M" | "A" | "D" | "R" | "?" — derived from porcelain index/worktree. */
  status: string;
  index: string;
  worktree: string;
  additions: number;
  deletions: number;
};

export type GitChanges = {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  /** Total tracked-changed file count. Drives the section header chip. */
  changedCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const POLL_MS = 4000;

function deriveStatus(e: GitStatusEntry): string {
  if (e.index === "?" || e.worktree === "?") return "?";
  if (e.index === "A" || e.worktree === "A") return "A";
  if (e.index === "D" || e.worktree === "D") return "D";
  if (e.index === "R" || e.worktree === "R") return "R";
  return "M";
}

export function useGitChanges(repoRoot: string | null | undefined): GitChanges {
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [stats, setStats] = useState<Map<string, FileDiffStat>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    if (!repoRoot) {
      setEntries([]);
      setStats(new Map());
      setLoading(false);
      return;
    }
    try {
      const [es, st] = await Promise.all([
        api.gitStatusV2(repoRoot),
        api.gitDiffStatsPerFile(repoRoot).catch(() => [] as FileDiffStat[]),
      ]);
      const map = new Map<string, FileDiffStat>();
      for (const s of st) map.set(s.path, s);
      setEntries(es);
      setStats(map);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    setLoading(true);
    refresh();
    if (!visible) return;
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, visible]);

  // Build ChangedFile rows. A single porcelain entry can be both staged
  // AND have unstaged changes (`MM`) — surface it in BOTH sections so
  // the user can stage/unstage each side independently. Untracked is
  // its own bucket (`??`).
  //
  // Memoize on entries+stats refs (state) so consumer-side useMemos
  // that take staged/unstaged/untracked as deps don't see fresh array
  // references on every render — that caused infinite render loops in
  // EditViewPanel, where an effect downstream of `changedFiles` set
  // state every commit.
  const buckets = useMemo(() => {
    const all: ChangedFile[] = entries.map((e) => {
      const s = stats.get(e.path);
      return {
        path: e.path,
        status: deriveStatus(e),
        index: e.index,
        worktree: e.worktree,
        additions: s?.additions ?? 0,
        deletions: s?.deletions ?? 0,
      };
    });
    const staged = all.filter((f) => f.index && f.index !== "?");
    const unstaged = all.filter(
      (f) => f.worktree && f.worktree !== "?" && f.index !== "?",
    );
    const untracked = all.filter((f) => f.index === "?" || f.worktree === "?");
    const trackedPaths = new Set<string>();
    for (const f of staged) trackedPaths.add(f.path);
    for (const f of unstaged) trackedPaths.add(f.path);
    return {
      staged,
      unstaged,
      untracked,
      changedCount: trackedPaths.size,
    };
  }, [entries, stats]);

  return {
    staged: buckets.staged,
    unstaged: buckets.unstaged,
    untracked: buckets.untracked,
    changedCount: buckets.changedCount,
    loading,
    error,
    refresh,
  };
}
