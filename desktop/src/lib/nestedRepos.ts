// Nested repositories: folders inside a project that are git repositories of
// their own (their own `.git`). The project's git ignores such a folder, or
// sees it as one untracked entry, so its edits never showed in Changes. The
// Changes panel lists their files in the project's own list, tagged with the
// repository they belong to, and drops the folder entry that stood in for it.
//
// Detection is a bounded walk on this machine's disk (`nested_repos_list`).
// A project open on another machine is not walked from here.

import { useEffect, useState } from "react";
import { api, type NestedDirty, type NestedRepo, type NestedWorktreeOutcome } from "./api";
import type { ChangedFile } from "./useGitChanges";
import { usePanelActive } from "./panelActive";
import { needsPolling } from "./place/workApi";

/** Re-walk this often while a panel shows the project: a repository cloned
 *  into it mid-session turns up without a restart. */
const REWALK_MS = 30_000;

const NONE: NestedRepo[] = [];

/** True when `path` (from the project root) is a nested repository's folder
 *  or anything inside it. */
export function isInsideNested(path: string, rels: readonly string[]): boolean {
  const p = path.replace(/\/+$/, "");
  return rels.some((rel) => p === rel || p.startsWith(`${rel}/`));
}

/** The project's own changed files, without the entries that only stand in
 *  for a nested repository (`?? cloud/`, a submodule's `M cloud`). Hands back
 *  the same array when nothing is dropped, so memos downstream hold. */
export function withoutNested(files: ChangedFile[], rels: readonly string[]): ChangedFile[] {
  if (rels.length === 0) return files;
  const kept = files.filter((f) => !isInsideNested(f.path, rels));
  return kept.length === files.length ? files : kept;
}

/** A nested repository's changed files with paths from the project root, so
 *  opening, diffing and staging them goes through the same project-relative
 *  path every other file uses (the backend sends it to the right repository). */
export function underFolder(files: ChangedFile[], rel: string): ChangedFile[] {
  return files.map((f) => ({ ...f, path: `${rel}/${f.path}` }));
}

/** The changed files of a project and every repository nested in it, as one
 *  set of lists with paths from the project root. A repository whose read
 *  hasn't answered yet adds nothing. */
export function withNestedChanges(
  own: { staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: ChangedFile[] },
  repos: readonly NestedRepo[],
  byRoot: ReadonlyMap<string, { staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: ChangedFile[] }>,
): { staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: ChangedFile[] } {
  let { staged, unstaged, untracked } = own;
  for (const repo of repos) {
    const theirs = byRoot.get(repo.root);
    if (!theirs) continue;
    if (theirs.staged.length) staged = [...staged, ...underFolder(theirs.staged, repo.rel_path)];
    if (theirs.unstaged.length) unstaged = [...unstaged, ...underFolder(theirs.unstaged, repo.rel_path)];
    if (theirs.untracked.length) untracked = [...untracked, ...underFolder(theirs.untracked, repo.rel_path)];
  }
  return { staged, unstaged, untracked };
}

/** The nested repository a path (from the project root) belongs to — the
 *  deepest one, when one sits inside another. None for the project's own. */
export function nestedRepoOf(path: string, repos: readonly NestedRepo[]): NestedRepo | undefined {
  let best: NestedRepo | undefined;
  for (const repo of repos) {
    if (!isInsideNested(path, [repo.rel_path])) continue;
    if (!best || repo.rel_path.length > best.rel_path.length) best = repo;
  }
  return best;
}

/** Number of distinct files with tracked changes across staged and unstaged. */
export function trackedCount(staged: ChangedFile[], unstaged: ChangedFile[]): number {
  const paths = new Set<string>();
  for (const f of staged) paths.add(f.path);
  for (const f of unstaged) paths.add(f.path);
  return paths.size;
}

export function sameRepos(a: readonly NestedRepo[], b: readonly NestedRepo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every(
    (x, i) =>
      x.rel_path === b[i].rel_path &&
      x.root === b[i].root &&
      x.kind === b[i].kind &&
      x.branch === b[i].branch &&
      x.base === b[i].base,
  );
}

/** One sentence per nested repository a new workspace could not copy, for
 *  the toast after it is made. Empty when every one came across. */
export function nestedCopyProblems(outcomes: readonly NestedWorktreeOutcome[] | undefined): string[] {
  return (outcomes ?? [])
    .filter((o) => o.state === "failed" || o.state === "skipped")
    .map((o) => `${o.rel_path}: ${o.detail ?? (o.state === "failed" ? "could not be copied" : "left out")}`);
}

/** The extra lines a "delete this copy" confirmation owes about nested
 *  repositories inside it. Empty when nothing would be lost. */
export function nestedLossLines(dirty: readonly NestedDirty[]): string[] {
  return dirty.map((d) => {
    if (d.standalone) {
      return `${d.rel_path}/ is a separate repository that only exists in this copy. Deleting the copy deletes it, history included.`;
    }
    const files = d.changed === 1 ? "1 file" : `${d.changed} files`;
    return `${d.rel_path}/ has ${files} with changes that aren't committed. They are deleted too; its commits are kept.`;
  });
}

const cache = new Map<string, NestedRepo[]>();

/** The nested repositories of a project root on this machine. Empty for a
 *  project open on another machine, and until the first walk answers. */
export function useNestedRepos(root: string | null | undefined): NestedRepo[] {
  const panelActive = usePanelActive();
  const local = !!root && !needsPolling(root);
  const [repos, setRepos] = useState<NestedRepo[]>(() => (root && local ? cache.get(root) ?? NONE : NONE));

  useEffect(() => {
    if (!root || !local) {
      setRepos(NONE);
      return;
    }
    setRepos(cache.get(root) ?? NONE);
    if (!panelActive) return;
    let alive = true;
    const load = () => {
      api
        .nestedReposList(root)
        .then((found) => {
          if (!alive) return;
          const prev = cache.get(root);
          const next = prev && sameRepos(prev, found) ? prev : found;
          cache.set(root, next);
          setRepos(next);
        })
        .catch(() => {
          // A failed walk keeps whatever was found last.
        });
    };
    load();
    const timer = window.setInterval(load, REWALK_MS);
    window.addEventListener("aura:git-changed", load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("aura:git-changed", load);
      window.removeEventListener("focus", load);
    };
  }, [root, local, panelActive]);

  return repos;
}
