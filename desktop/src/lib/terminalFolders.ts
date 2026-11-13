// Folders the terminal panel has been pointed at, newest first.
//
// A terminal here always opened in the project root, which is the one place
// you least often need a shell for — the folder you want is a sibling repo, a
// scratch directory, a log dir. So the `+` menu can now take any folder on
// disk, and the ones you picked are remembered: picking the same folder twice
// should cost one click, not another trip through the file panel.
//
// This is the whole of that memory — a list of paths, the newest first, no
// per-folder state. It stays separate from `recentProjects` on purpose: a
// folder you opened a shell in is not a project you opened, and letting one
// leak into the other would put scratch directories in the Projects list.

const FOLDERS_KEY = "aura.terminal.folders";

/** How many folders the menu remembers. Long enough that the folders you
 *  actually revisit stay in reach, short enough to stay a glanceable list. */
export const FOLDERS_MAX = 8;

/** What the menu row and the terminal tab call a folder: its own name, not
 *  the whole path. The path is still shown beside it in the menu, so the
 *  label only has to tell two picks apart at a glance. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.split("/").pop() || trimmed;
}

/** Where a folder sits, for the dimmer second line in the menu — the name
 *  alone can't tell two `src` folders apart. The caller abbreviates the home
 *  prefix (`tildePath`) so a long path doesn't crowd out the name. */
export function folderParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
}

/** Remember a folder: newest first, no duplicates, capped. Returns a new
 *  list — the caller owns the state, this only decides the order. */
export function rememberFolder(prev: string[], path: string): string[] {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return prev;
  const rest = prev.filter((p) => p.replace(/\/+$/, "") !== trimmed);
  return [trimmed, ...rest].slice(0, FOLDERS_MAX);
}

/** Drop a folder from the list (its menu row's ✕). */
export function forgetFolder(prev: string[], path: string): string[] {
  const trimmed = path.replace(/\/+$/, "");
  return prev.filter((p) => p.replace(/\/+$/, "") !== trimmed);
}

/** The remembered folders. A browser with storage blocked, or a stored value
 *  that isn't a list of strings, reads as "none remembered yet" — the menu's
 *  "Choose Folder…" works regardless, so there is nothing to recover from. */
export function readFolders(): string[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, FOLDERS_MAX);
  } catch {
    return [];
  }
}

/** Persist the remembered folders. Best-effort: losing the list costs a trip
 *  through the picker, so a storage failure is never worth surfacing. */
export function persistFolders(folders: string[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.slice(0, FOLDERS_MAX)));
  } catch {
    /* best-effort */
  }
}
