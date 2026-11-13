// The project's folders as file-tree rows, and the filtered views of them.
// Pure, so every mapping here is tested on its own.

import type { DirEntry } from "../../../lib/api";
import type { GitChanges } from "../../../lib/useGitChanges";
import type { FileTreeNode } from "../../ui/file-tree";

/** The row a new file or folder is named in before it exists. */
export const NEW_ENTRY_ID = "\u0000new-entry";

/** What git says about one file, for its mark, its counts and its menu. */
export type FileChange = {
  status: string;
  added: number;
  removed: number;
  /** Has working-tree changes Discard can put back (or is a new file). */
  discardable: boolean;
  untracked: boolean;
};

export function parentOf(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? null : path.slice(0, idx);
}

/** Whether dragged `paths` can move into folder `dir`: they can unless every
 *  one is that folder, a folder above it, or already directly inside it. */
export function canMoveInto(paths: string[], dir: string): boolean {
  return paths.some((p) => p !== dir && !dir.startsWith(p + "/") && parentOf(p) !== dir);
}

export function relativeTo(root: string, path: string): string {
  const base = root.replace(/\/+$/, "");
  return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// A capital letter on its own says nothing to someone who has never used git,
// so every mark carries the sentence it stands for, on hover and to a screen
// reader. `?` (untracked) is drawn as a new file; a conflict gets its own mark
// so it never reads as an ordinary edit.
const MARKS: Record<string, { status: NonNullable<FileTreeNode["status"]>; label: string }> = {
  M: { status: "modified", label: "Changed. You've edited this since the last save point" },
  A: { status: "added", label: "Added. New, and already marked to go into the next save point" },
  "?": { status: "added", label: "New. This file isn't being tracked yet" },
  D: { status: "deleted", label: "Deleted" },
  R: { status: "modified", label: "Renamed or moved" },
  U: { status: "conflict", label: "Conflict. Two versions disagree here and one of them has to win" },
};

/** Every changed file by its path inside the project. */
export function changeMap(git: Pick<GitChanges, "staged" | "unstaged" | "untracked">) {
  const map = new Map<string, FileChange>();
  const put = (path: string, status: string, added: number, removed: number, discardable: boolean, untracked: boolean) => {
    const known = map.get(path);
    map.set(path, {
      status: known?.status ?? status,
      added,
      removed,
      discardable: discardable || (known?.discardable ?? false),
      untracked: untracked || (known?.untracked ?? false),
    });
  };
  for (const f of git.staged) put(f.path, f.status, f.additions, f.deletions, false, false);
  for (const f of git.unstaged) put(f.path, f.status, f.additions, f.deletions, true, false);
  for (const f of git.untracked) put(f.path, "?", f.additions, f.deletions, true, true);
  return map;
}

/** The project's changes with each nested repository's own laid in under its
 *  folder. The project's git can't see inside a separate repository, so
 *  without this its files would never carry a mark. The folder's own entry
 *  (the project reporting it as one new folder) is dropped. */
export function withNestedChanges(
  own: Map<string, FileChange>,
  nested: ReadonlyArray<{ rel: string; git: Pick<GitChanges, "staged" | "unstaged" | "untracked"> }>,
): Map<string, FileChange> {
  if (nested.length === 0) return own;
  const out = new Map(own);
  for (const { rel, git } of nested) {
    out.delete(rel);
    out.delete(`${rel}/`);
    for (const [path, change] of changeMap(git)) out.set(`${rel}/${path}`, change);
  }
  return out;
}

/** One file row, marked from git. A conflict reported by the listing wins over
 *  the change store, which has no letter for one. */
export function fileNode(path: string, name: string, listed: string | null, change?: FileChange): FileTreeNode {
  const letter = listed === "U" ? "U" : (change?.status ?? listed ?? null);
  const mark = letter ? MARKS[letter] : undefined;
  const node: FileTreeNode = { id: path, name };
  if (mark) {
    node.status = mark.status;
    node.statusLabel = mark.label;
  }
  if (change && change.added + change.removed > 0) {
    node.added = change.added;
    node.removed = change.removed;
  }
  return node;
}

/** The tree as far as it has been read. A folder not read yet has no
 *  children, and fills in once it is opened. */
export function listingNodes(
  root: string,
  listings: ReadonlyMap<string, DirEntry[]>,
  changes: ReadonlyMap<string, FileChange>,
): FileTreeNode[] {
  const build = (dir: string): FileTreeNode[] =>
    (listings.get(dir) ?? []).map((entry) =>
      entry.is_dir
        ? { id: entry.path, name: entry.name, children: build(entry.path) }
        : fileNode(entry.path, entry.name, entry.git_status, changes.get(relativeTo(root, entry.path))),
    );
  return build(root);
}

/** How many name matches go on screen. Past a few hundred the list stops
 *  being an answer; the footer says how many were left out. */
export const SEARCH_LIMIT = 300;

/** The project's paths that match `query` (lower case), best first: the file
 *  named exactly that, then one that starts with it, then one that contains
 *  it, then one where only a folder matched — shorter names and shallower
 *  paths first within each. */
export function rankHits(index: string[], query: string): { hits: string[]; total: number } {
  const scored: Array<{ rel: string; name: string; tier: number }> = [];
  for (const rel of index) {
    const name = baseName(rel);
    const lower = name.toLowerCase();
    const tier =
      lower === query
        ? 0
        : lower.startsWith(query)
          ? 1
          : lower.includes(query)
            ? 2
            : rel.toLowerCase().includes(query)
              ? 3
              : -1;
    if (tier >= 0) scored.push({ rel, name, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.name.length - b.name.length ||
      a.rel.split("/").length - b.rel.split("/").length ||
      a.rel.localeCompare(b.rel),
  );
  return { hits: scored.slice(0, SEARCH_LIMIT).map((s) => s.rel), total: scored.length };
}

/** Matching paths drawn as a tree of their folders. Insertion keeps the
 *  ranking: the folder holding the best match comes first. */
export function hitTree(
  root: string,
  hits: string[],
  changes: ReadonlyMap<string, FileChange>,
): FileTreeNode[] {
  const base = root.replace(/\/+$/, "");
  type Folder = { node: FileTreeNode; folders: Map<string, Folder> };
  const top: Folder = { node: { id: base, name: "", children: [] }, folders: new Map() };
  for (const rel of hits) {
    const parts = rel.split("/").filter(Boolean);
    let at = top;
    let path = base;
    for (const part of parts.slice(0, -1)) {
      path = `${path}/${part}`;
      let next = at.folders.get(part);
      if (!next) {
        next = { node: { id: path, name: part, children: [] }, folders: new Map() };
        at.folders.set(part, next);
        at.node.children!.push(next.node);
      }
      at = next;
    }
    const name = parts[parts.length - 1];
    if (name) at.node.children!.push(fileNode(`${base}/${rel}`, name, null, changes.get(rel)));
  }
  return top.node.children!;
}

/** Rows whose name matches, kept with the folders above them. */
export function filterNodes(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? filterNodes(node.children, query) : undefined;
    return node.name.toLowerCase().includes(query) || children?.length ? [{ ...node, children }] : [];
  });
}

export function folderIds(nodes: FileTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children) {
      out.push(node.id);
      folderIds(node.children, out);
    }
  }
  return out;
}

/** Row ids top to bottom, as the tree draws them. */
export function visibleIds(nodes: FileTreeNode[], expanded: ReadonlySet<string>, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.id);
    if (node.children && expanded.has(node.id)) visibleIds(node.children, expanded, out);
  }
  return out;
}

/** The tree with a nameless row first inside `parent` (or at the top when
 *  `parent` is not on screen), for naming a new file or folder in place. */
export function withNewEntry(nodes: FileTreeNode[], parent: string, folder: boolean): FileTreeNode[] {
  const entry: FileTreeNode = folder
    ? { id: NEW_ENTRY_ID, name: "", children: [] }
    : { id: NEW_ENTRY_ID, name: "" };
  let placed = false;
  const place = (items: FileTreeNode[]): FileTreeNode[] =>
    items.map((node) => {
      if (!node.children) return node;
      if (node.id === parent) {
        placed = true;
        return { ...node, children: [entry, ...node.children] };
      }
      return { ...node, children: place(node.children) };
    });
  const next = place(nodes);
  return placed ? next : [entry, ...nodes];
}
