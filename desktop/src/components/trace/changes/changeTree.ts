// The Changes tab's file list as a model: the flat changeset folded into a
// folder hierarchy for the shared file tree, ordered by the rule the reader
// picked.
//
// A changeset of a dozen files reads fine alphabetically. One of forty does
// not: the file that carries the change is somewhere in the middle of it, and
// the only way to find it is to read every name. So the list can also be
// ordered by how much a file changed, and by which change is newest — the two
// questions people actually arrive with.
//
// Folders are ordered by the same rule as the files inside them (summed churn,
// newest descendant), so a re-order moves the whole branch rather than
// shuffling leaves inside a tree that still reads alphabetically.

import type { IntentChangesetFile } from "../../../lib/api";
import type { FileTreeNode } from "../../ui/file-tree";

export type ChangeSort = "path" | "churn" | "recent";

export const CHANGE_SORTS: { id: ChangeSort; label: string; hint: string }[] = [
  { id: "path", label: "Name", hint: "Folders and files A–Z" },
  { id: "churn", label: "Most changed", hint: "Largest +/− first" },
  { id: "recent", label: "Newest", hint: "Most recently changed first" },
];

/** What happened to a file, in the shared tree's terms and in words. The tree
 *  marks four states; a rename is a modification whose label says so. */
export function changeStatus(status: string | undefined): {
  status: "added" | "modified" | "deleted";
  word: string;
} {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "added" || s === "a" || s === "new") return { status: "added", word: "added" };
  if (s === "deleted" || s === "d" || s === "removed") {
    return { status: "deleted", word: "deleted" };
  }
  if (s === "renamed" || s === "r") return { status: "modified", word: "renamed" };
  return { status: "modified", word: "modified" };
}

/** The recorded +/− for a file, or null when the changeset carries none —
 *  a live working-tree claim, whose counts aren't known until its diff is. */
export function fileChurn(f: IntentChangesetFile): { adds: number; dels: number } | null {
  if (typeof f.additions !== "number" && typeof f.deletions !== "number") return null;
  return {
    adds: typeof f.additions === "number" ? f.additions : 0,
    dels: typeof f.deletions === "number" ? f.deletions : 0,
  };
}

/** Millis for ordering, or `null` when the file carries no stamp — a working
 *  copy edit that was never committed has nothing to be newer than. */
function changedAt(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

type Leaf = { file: IntentChangesetFile; name: string; adds: number; dels: number; at: number | null };
type Branch = {
  name: string;
  path: string;
  folders: Branch[];
  files: Leaf[];
  adds: number;
  dels: number;
  count: number;
  at: number | null;
};
type RawFolder = { name: string; path: string; folders: Map<string, RawFolder>; files: Leaf[] };

/** A folder's id in the tree. Prefixed so a folder can never share an id with
 *  a file of the same path (a file that became a directory in one change). */
export const folderId = (path: string) => `dir:${path}`;

/** Build the folder hierarchy from the flat changeset, collapse any
 *  single-child directory chain into one row (so `a/b/c/file.ts` reads as a
 *  single `a/b/c` folder), and order every level by one rule. */
export function buildChangeTree(
  files: IntentChangesetFile[],
  sort: ChangeSort = "path",
): { nodes: FileTreeNode[]; fileOrder: string[]; folderIds: string[] } {
  const root: RawFolder = { name: "", path: "", folders: new Map(), files: [] };
  for (const f of files) {
    const segs = f.path.split("/").filter(Boolean);
    const name = segs.length > 0 ? segs[segs.length - 1] : f.path;
    let cur = root;
    let acc = "";
    for (const d of segs.slice(0, -1)) {
      acc = acc ? `${acc}/${d}` : d;
      let next = cur.folders.get(d);
      if (!next) {
        next = { name: d, path: acc, folders: new Map(), files: [] };
        cur.folders.set(d, next);
      }
      cur = next;
    }
    const churn = fileChurn(f);
    cur.files.push({
      file: f,
      name,
      adds: churn?.adds ?? 0,
      dels: churn?.dels ?? 0,
      at: changedAt(f.changed_at),
    });
  }

  // One comparator for both folders and files, so a branch and its leaves are
  // never ordered by different rules. Files with nothing to compare on — no
  // churn recorded, no stamp — fall to the end rather than to the top, where a
  // zero would otherwise outrank a real number, and settle alphabetically
  // among themselves so the order is stable between renders.
  type Sortable = { name: string; adds: number; dels: number; at: number | null };
  function compare(a: Sortable, b: Sortable): number {
    if (sort === "churn") {
      const d = b.adds + b.dels - (a.adds + a.dels);
      if (d !== 0) return d;
    } else if (sort === "recent" && a.at !== b.at) {
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at - a.at;
    }
    return a.name.localeCompare(b.name);
  }

  function collapse(raw: RawFolder): Branch {
    let name = raw.name;
    let work = raw;
    while (work.files.length === 0 && work.folders.size === 1) {
      const only = work.folders.values().next().value as RawFolder;
      name = `${name}/${only.name}`;
      work = only;
    }
    const folders = [...work.folders.values()].map(collapse).sort(compare);
    const leaves = [...work.files].sort(compare);
    let adds = 0;
    let dels = 0;
    let count = leaves.length;
    let at: number | null = null;
    for (const c of [...folders, ...leaves]) {
      adds += c.adds;
      dels += c.dels;
      if (c.at !== null && (at === null || c.at > at)) at = c.at;
    }
    for (const f of folders) count += f.count;
    return { name, path: work.path, folders, files: leaves, adds, dels, count, at };
  }

  const fileOrder: string[] = [];
  const folderIds: string[] = [];
  // Folders first, depth-first — the order the tree draws, so the first file
  // here is the first file on screen (the one a wide layout opens to).
  function toNodes(b: Pick<Branch, "folders" | "files">): FileTreeNode[] {
    const out: FileTreeNode[] = [];
    for (const f of b.folders) {
      const id = folderId(f.path);
      folderIds.push(id);
      out.push({ id, name: f.name, children: toNodes(f) });
    }
    for (const leaf of b.files) {
      fileOrder.push(leaf.file.path);
      const { status, word } = changeStatus(leaf.file.status);
      const churn = fileChurn(leaf.file);
      out.push({
        id: leaf.file.path,
        name: leaf.name,
        status,
        statusLabel: word,
        added: churn?.adds,
        removed: churn?.dels,
      });
    }
    return out;
  }

  // The root itself is never a row, so its own level is never folded — only
  // the folders under it collapse their chains.
  const level = {
    folders: [...root.folders.values()].map(collapse).sort(compare),
    files: [...root.files].sort(compare),
  };
  return { nodes: toNodes(level), fileOrder, folderIds };
}

/** Roll-ups for a folder, for its hover title: the tree colours only files,
 *  so a folder's sum is said in words rather than drawn as another count. */
export function folderSummary(
  files: IntentChangesetFile[],
  dirPath: string,
): { count: number; adds: number; dels: number } {
  let count = 0;
  let adds = 0;
  let dels = 0;
  const prefix = `${dirPath}/`;
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    count += 1;
    const churn = fileChurn(f);
    adds += churn?.adds ?? 0;
    dels += churn?.dels ?? 0;
  }
  return { count, adds, dels };
}
