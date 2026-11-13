// The Changes tab's list, read in one place for everything that counts it.
// The header ("9 files changed") and the tab's badge ("Changes 9") both come
// from here, so a file the list draws is a file both numbers count: the
// project's own changes with each nested repository's stand-in folder
// (`?? cloud/`) dropped, every nested repository's files added under their
// folder, and generated and ignored files counted too — they are only folded
// at the end of the list, and a header reading "0 files changed" above a
// file with +17 −37 reads as broken.

import { useMemo } from "react";
import type { NestedRepo } from "../../lib/api";
import { useNestedRepos, withNestedChanges, withoutNested } from "../../lib/nestedRepos";
import {
  useGitChanges,
  useGitChangesMany,
  type ChangedFile,
  type GitChanges,
} from "../../lib/useGitChanges";
import { splitChanges, type ChangeParts } from "./changeGroups";

type Buckets = { staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: ChangedFile[] };

export type ChangeList = {
  /** The project's own read, with its loading and error state. */
  changes: GitChanges;
  nested: NestedRepo[];
  /** Every listed file, by git state, with paths from the project root. */
  listed: Buckets;
  parts: ChangeParts;
};

/** The project's changes as the list draws them. A nested repository shows up
 *  in the project's own status only as one untracked folder standing in for
 *  everything inside it, so that folder goes and the repository's own files
 *  come in instead. A submodule's entry is a real change to the project (the
 *  commit it records moved) and stays. Without `withNested` (the Git view,
 *  which keeps each nested repository under its own heading) only the
 *  stand-ins go. */
export function changeList(
  own: Buckets,
  nested: readonly NestedRepo[],
  byRoot: ReadonlyMap<string, Buckets>,
  withNested: boolean,
): Pick<ChangeList, "listed" | "parts"> {
  const standIns = nested.filter((n) => n.kind === "nested").map((n) => n.rel_path);
  const mine = {
    staged: own.staged,
    unstaged: own.unstaged,
    untracked: withoutNested(own.untracked, standIns),
  };
  const listed = withNestedChanges(mine, withNested ? nested : [], byRoot);
  return { listed, parts: splitChanges(listed.staged, listed.unstaged, listed.untracked) };
}

/** Every file the list draws, once by path: real edits first, then the
 *  generated and ignored files folded at the end. A file staged and edited
 *  again is in both git lists with the same line counts, so one copy carries
 *  its +/−. */
export function listedFiles(parts: ChangeParts): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of [...parts.sigUntracked, ...parts.sigUnstaged, ...parts.sigStaged]) {
    if (!byPath.has(f.path)) byPath.set(f.path, f);
  }
  for (const { file } of parts.noise) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return [...byPath.values()];
}

/** What "N files changed" counts, and the number beside the Changes tab:
 *  every file the list draws, wherever it is staged, whichever repository it
 *  is in, generated or not. */
export function changedFileCount(parts: ChangeParts): number {
  return listedFiles(parts).length;
}

export function useChangeList(
  repoRoot: string | null | undefined,
  { withNested }: { withNested: boolean },
): ChangeList {
  const changes = useGitChanges(repoRoot);
  const nested = useNestedRepos(repoRoot);
  const roots = useMemo(() => (withNested ? nested.map((n) => n.root) : []), [withNested, nested]);
  const byRoot = useGitChangesMany(roots);
  const { staged, unstaged, untracked } = changes;
  const { listed, parts } = useMemo(
    () => changeList({ staged, unstaged, untracked }, nested, byRoot, withNested),
    [staged, unstaged, untracked, nested, byRoot, withNested],
  );
  return { changes, nested, listed, parts };
}

/** The number beside the Changes tab: the Changes header's count, from the
 *  same list. `undefined` until git has answered for the project — a number
 *  nobody has read yet is not zero. A read that fails later keeps the last
 *  list, and so the last count. */
export function useChangedFileCount(repoRoot: string | null | undefined): number | undefined {
  const { changes, parts } = useChangeList(repoRoot, { withNested: true });
  const count = useMemo(() => changedFileCount(parts), [parts]);
  return changes.loading ? undefined : count;
}
