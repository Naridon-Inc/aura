// Changed files as file-tree rows. Pure, so the mapping is tested on its own.

import type { FileTreeNode } from "../ui/file-tree";

export type ChangeMode = "staged" | "unstaged" | "untracked";

export type ChangeLike = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

/** Git's status letter as the tree's three states. A rename or a type change
 *  is a modification as far as a reviewer is concerned. */
export function treeStatus(status: string): FileTreeNode["status"] {
  const s = status.trim().toUpperCase();
  if (s === "A" || s === "?" || s === "??") return "added";
  if (s === "D") return "deleted";
  return "modified";
}

export function nodeId(mode: string, path: string): string {
  return `${mode}:${path}`;
}

/** Each path's shortest trailing run of segments that no other path in the
 *  list shares — the file name alone, unless two files share it, in which
 *  case just enough of their folders to tell them apart. */
export function displayNames(paths: string[]): Map<string, string> {
  const parts = new Map(paths.map((p) => [p, p.split("/").filter(Boolean)]));
  const depth = new Map(paths.map((p) => [p, 1]));
  const tail = (p: string) => {
    const segs = parts.get(p) ?? [p];
    return segs.slice(-Math.min(depth.get(p) ?? 1, segs.length)).join("/");
  };
  for (;;) {
    const byName = new Map<string, string[]>();
    for (const p of paths) {
      const name = tail(p);
      byName.set(name, [...(byName.get(name) ?? []), p]);
    }
    let grew = false;
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      for (const p of group) {
        const d = depth.get(p) ?? 1;
        if (d < (parts.get(p)?.length ?? 1)) {
          depth.set(p, d + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(paths.map((p) => [p, tail(p)]));
}

/** One row per file, labelled by its name (see `displayNames`). */
export function changeNodes(files: ChangeLike[], mode: string): FileTreeNode[] {
  const names = displayNames(files.map((f) => f.path));
  return files.map((f) => ({
    id: nodeId(mode, f.path),
    name: names.get(f.path) ?? f.path,
    status: mode === "untracked" ? "added" : treeStatus(f.status),
    added: f.additions,
    removed: f.deletions,
  }));
}

export function totals(files: ChangeLike[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.additions;
    removed += f.deletions;
  }
  return { added, removed };
}
