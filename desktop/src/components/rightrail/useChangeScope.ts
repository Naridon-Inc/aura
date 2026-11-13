// Which changes the Changes tab lists: the uncommitted ones (the default),
// everything this branch changed against a target branch, or one commit.
//
// Uncommitted files come from `useGitChanges` in the panel; this hook reads
// the branch, its candidates for a target, its recent commits, and — when a
// wider scope is picked — the files that scope changed.

import { useEffect, useMemo, useState } from "react";
import { api, type BranchDiffFile, type CommitEntry, type GraphCommit } from "../../lib/api";
import { remotePlaceForRoot } from "../../lib/activeMachine";
import * as work from "../../lib/place/workApi";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { parseShownCommit } from "../git/detail/shownCommit";
import type { GitCommitSummary } from "../ui/git-workflow";

export const UNCOMMITTED = "uncommitted";
export const ALL_CHANGES = "all";
const COMMIT_LIMIT = 15;

function defaultTarget(branches: string[], current: string): string {
  for (const name of ["main", "master", "develop", "trunk"]) {
    if (branches.includes(name) && name !== current) return name;
  }
  return branches.find((b) => b !== current) ?? current;
}

/** The commits HEAD stands on, newest first: the first-parent line from the
 *  commit carrying the HEAD ref. The machine answers with its whole graph
 *  (`git log --all`), and a row for a commit on some other branch would be a
 *  scope this checkout cannot diff. */
export function headLine(graph: GraphCommit[], limit: number): CommitEntry[] {
  const bySha = new Map(graph.map((c) => [c.sha, c]));
  let at: GraphCommit | undefined =
    graph.find((c) => c.refs.some((r) => r.kind === "head")) ?? graph[0];
  const out: CommitEntry[] = [];
  const seen = new Set<string>();
  while (at && out.length < limit && !seen.has(at.sha)) {
    seen.add(at.sha);
    out.push({ sha: at.sha, author: at.author, timestamp: at.timestamp, subject: at.subject, branch: "" });
    at = at.parents[0] ? bySha.get(at.parents[0]) : undefined;
  }
  return out;
}

/** The recent commits of the checkout, wherever it stands. */
function recentCommits(repoRoot: string): Promise<CommitEntry[]> {
  return remotePlaceForRoot(repoRoot)
    ? work.gitCommitGraph(repoRoot, COMMIT_LIMIT * 4).then((g) => headLine(g, COMMIT_LIMIT))
    : api.gitRecentCommits(repoRoot, COMMIT_LIMIT);
}

/** The files a range touched. On a machine the two ranges the picker offers
 *  are read the ways the machine already answers: one commit from its
 *  `git show`, and the branch from its diff against the fork base. */
async function rangeFiles(
  repoRoot: string,
  range: [string, string],
  commitSha: string | null,
): Promise<BranchDiffFile[]> {
  if (!remotePlaceForRoot(repoRoot)) return api.gitBranchDiffFiles(repoRoot, range[0], range[1]);
  if (commitSha) {
    const shown = parseShownCommit(await work.gitShowCommit(repoRoot, commitSha));
    if (!shown) throw new Error("The machine didn't show this commit.");
    return shown.files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: Math.max(0, f.added),
      deletions: Math.max(0, f.deleted),
    }));
  }
  const rows = await work.gitDiffStatsPerFile(repoRoot, true);
  return rows.map((r) => ({ path: r.path, status: "M", additions: r.additions, deletions: r.deletions }));
}

export function useChangeScope(repoRoot: string, refreshTick: number) {
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [commits, setCommits] = useState<Array<GitCommitSummary & { sha: string }>>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [scope, setScope] = useState(UNCOMMITTED);
  const [files, setFiles] = useState<BranchDiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      work.gitBranch(repoRoot).catch(() => ""),
      work.gitBranches(repoRoot).catch(() => []),
      recentCommits(repoRoot).catch(() => []),
    ]).then(([current, list, recent]) => {
      if (!alive) return;
      setBranch(current);
      setBranches(list.filter((b) => !b.is_remote).map((b) => b.name));
      setCommits(
        recent.map((c) => ({
          id: c.sha.slice(0, 7),
          sha: c.sha,
          message: c.subject,
          author: c.author,
          date: relativeAgeFromSecs(c.timestamp),
        })),
      );
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, refreshTick]);

  const targetBranch = target ?? defaultTarget(branches, branch);

  // A wider scope reads its own file list; the uncommitted scope needs none.
  useEffect(() => {
    if (scope === UNCOMMITTED) {
      setFiles(null);
      setError(null);
      return;
    }
    const commit = commits.find((c) => c.id === scope);
    const range: [string, string] | null =
      scope === ALL_CHANGES
        ? targetBranch && targetBranch !== branch
          ? [targetBranch, "HEAD"]
          : null
        : commit
          ? [`${commit.sha}^`, commit.sha]
          : null;
    if (!range) {
      setFiles([]);
      return;
    }
    let alive = true;
    setFiles(null);
    rangeFiles(repoRoot, range, commit?.sha ?? null)
      .then((list) => {
        if (!alive) return;
        setFiles(list);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setFiles([]);
        setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, scope, targetBranch, branch, commits, refreshTick]);

  const summaries = useMemo<GitCommitSummary[]>(
    () => commits.map(({ id, message, author, date }) => ({ id, message, author, date })),
    [commits],
  );

  return {
    branch,
    branches,
    commits: summaries,
    targetBranch,
    setTargetBranch: setTarget,
    scope,
    setScope,
    /** The full sha behind a commit scope, or null for the other scopes. */
    commitSha: commits.find((c) => c.id === scope)?.sha ?? null,
    /** The scope's committed files; null while reading or for "uncommitted". */
    files,
    error,
  };
}
