// What the right panel needs to show a machine chat's worktree: which
// machine-book entry reaches the machine, and the trees the box's answers
// become.
//
// Every read goes to the machine over the same ssh the chat attaches with,
// through the `place_*` commands. Nothing here falls back to a checkout on
// this laptop: a workspace on a machine is the files on that machine.

import type { DirEntry, FileDiffStat, GitStatusEntry, Machine } from "../../lib/api";
import type { CloudWorkspacePlace } from "../../lib/cloudWorkspacesApi";
import type { WorkAt } from "../../lib/place/placeWork";
import type { FileTreeNode } from "../ui/file-tree";

type BookEntry = Pick<Machine, "id" | "name" | "repo_path" | "project_root">;

/** Where the panel reads from, or why it can't. */
export type BoxWorkTarget =
  | { kind: "ok"; at: WorkAt }
  | { kind: "not-connected"; machine: string }
  | { kind: "no-folder"; machine: string };

const trimSlash = (p: string) => p.replace(/\/+$/, "");

/** The machine-book entry the chat attaches through, chosen the way the
 *  desktop's attach chooses it: the entry for the project the worktree was
 *  made from first, then one filed under a checkout on this laptop. A tie
 *  goes to the later entry, as it does there.
 *
 *  The worktree's own path on the machine is both the root the panel's paths
 *  are spelled under and the folder the commands run in, so every path the
 *  panel shows is the machine's. */
export function boxWorkAt(
  book: readonly BookEntry[],
  place: Pick<CloudWorkspacePlace, "machine" | "remote_root">,
): BoxWorkTarget {
  const machine = place.machine.trim();
  const root = trimSlash(place.remote_root.trim());
  const mirrors = (m: BookEntry) => {
    const p = trimSlash(m.repo_path ?? "");
    return !!p && (root === p || root.startsWith(`${p}-`));
  };
  const filed = (m: BookEntry) => !!m.project_root?.trim();
  let best: BookEntry | null = null;
  let score = -1;
  for (const m of book) {
    if (m.name !== machine) continue;
    const s = (mirrors(m) ? 2 : 0) + (filed(m) ? 1 : 0);
    if (s >= score) {
      best = m;
      score = s;
    }
  }
  if (!best) return { kind: "not-connected", machine };
  if (!root.startsWith("/") || root.includes("..")) return { kind: "no-folder", machine };
  return { kind: "ok", at: { machineId: best.id, repoRoot: root, remoteRoot: root } };
}

// ─── All files ───────────────────────────────────────────────────────────

const GIT_MARK: Record<string, FileTreeNode["status"]> = {
  "?": "added",
  A: "added",
  D: "deleted",
  U: "conflict",
  M: "modified",
  R: "modified",
  C: "modified",
  T: "modified",
};

const MARK_WORDS: Record<NonNullable<FileTreeNode["status"]>, string> = {
  added: "New",
  modified: "Changed",
  deleted: "Deleted",
  conflict: "Conflicted",
};

/** One folder's listing as tree rows. A folder's children are read when it
 *  is opened, so an unread folder carries an empty list: the tree draws it as
 *  a folder, and opening it is what fills it. */
export function dirNodes(entries: readonly DirEntry[]): FileTreeNode[] {
  return entries.map((e) => {
    const status = e.git_status ? GIT_MARK[e.git_status] : undefined;
    return {
      id: e.path,
      name: e.name,
      ...(e.is_dir ? { children: [] } : {}),
      ...(status ? { status, statusLabel: MARK_WORDS[status] } : {}),
    };
  });
}

/** The tree with one folder's children put in. */
export function withChildren(
  nodes: readonly FileTreeNode[],
  folder: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return nodes.map((n) =>
    n.id === folder
      ? { ...n, children }
      : n.children
        ? { ...n, children: withChildren(n.children, folder, children) }
        : n,
  );
}

// ─── Changes ─────────────────────────────────────────────────────────────

/** One changed file, in the shape the cloud panel's change tree reads. */
export type BoxChangedFile = {
  path: string;
  status: string | null;
  additions: number;
  deletions: number;
};

function wordOf(entry: GitStatusEntry | undefined): string | null {
  if (!entry) return null;
  const letters = `${entry.index}${entry.worktree}`;
  if (letters.includes("U")) return "conflicted";
  if (letters.includes("?") || letters.includes("A")) return "added";
  if (letters.includes("D")) return "removed";
  return "modified";
}

/** Everything the branch changed since it left its base, committed or not,
 *  each with git's word for the part not yet committed. A file only commits
 *  touched has no word: git status says nothing about it, and the panel
 *  doesn't guess. */
export function boxChanges(
  stats: readonly FileDiffStat[],
  status: readonly GitStatusEntry[],
): BoxChangedFile[] {
  const byPath = new Map(status.map((s) => [s.path, s]));
  const seen = new Set<string>();
  const out: BoxChangedFile[] = [];
  for (const s of stats) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    out.push({
      path: s.path,
      status: wordOf(byPath.get(s.path)),
      additions: s.additions,
      deletions: s.deletions,
    });
  }
  return out;
}
