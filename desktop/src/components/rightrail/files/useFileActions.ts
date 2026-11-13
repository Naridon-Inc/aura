// What All files can do to the project: make, rename, move, delete and put
// back files, and hand them to other apps. Changes go through the place seam,
// so a tree drawn for a workspace on a machine changes the files on that box,
// where the listing came from (AURA-1306).

import { useEffect, useState } from "react";
import { api, type EditorInfo } from "../../../lib/api";
import { OS_FILE_DROP_COMPOSER } from "../../../lib/osFileDrop";
import {
  fsCreateFile,
  fsCreateFolder,
  fsDelete,
  fsRename,
  gitDiscard,
} from "../../../lib/place/workApi";
import { askConfirm } from "../../ui/ask";
import { baseName, parentOf, relativeTo } from "./fileNodes";

/** The folder something lives in, or the project itself at the top. */
const folderOf = (root: string, path: string) => parentOf(path) ?? root;

export function useFileActions({
  root,
  selected,
  onSelect,
  relist,
  relistAll,
  open,
  afterChange,
}: {
  root: string;
  selected: string | null;
  onSelect: (path: string) => void;
  relist: (dir: string) => Promise<void>;
  relistAll: (quiet?: boolean) => Promise<void>;
  /** Opens a folder, so what was just made in it is on screen. */
  open: (dir: string) => void;
  /** Paths moved: the name index and the git marks are out of date. */
  afterChange: () => void;
}) {
  // The last thing that failed, said under the rows until the next action.
  const [problem, setProblem] = useState<string | null>(null);

  const attempt = async (work: () => Promise<void>) => {
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(String(e));
    } finally {
      afterChange();
    }
  };

  const create = (parent: string, name: string, folder: boolean) =>
    attempt(async () => {
      const dest = `${parent.replace(/\/+$/, "")}/${name}`;
      await (folder ? fsCreateFolder(dest) : fsCreateFile(dest));
      if (parent !== root) open(parent);
      await relist(parent);
      if (!folder) onSelect(dest);
    });

  const rename = (path: string, name: string) =>
    attempt(async () => {
      if (name === baseName(path)) return;
      const dir = folderOf(root, path);
      const dest = `${dir.replace(/\/+$/, "")}/${name}`;
      await fsRename(path, dest);
      await relist(dir);
      if (selected === path) onSelect(dest);
    });

  /** `fs_rename` is the move, and it is atomic. A path already in the folder,
   *  or a folder dropped into itself, stays where it is. */
  const move = (paths: string[], destDir: string) =>
    attempt(async () => {
      let moved = 0;
      const failed: string[] = [];
      for (const from of paths) {
        if (from === destDir || destDir.startsWith(from + "/") || parentOf(from) === destDir) continue;
        const dest = `${destDir}/${baseName(from)}`;
        try {
          await fsRename(from, dest);
          moved++;
          if (selected === from) onSelect(dest);
        } catch (e) {
          failed.push(String(e));
        }
      }
      if (moved > 0) {
        open(destDir);
        await relistAll(true);
      }
      if (failed.length > 0) throw new Error(failed.join("\n"));
    });

  const remove = (paths: string[], folder: boolean) =>
    attempt(async () => {
      if (paths.length === 0) return;
      const many = paths.length > 1;
      const names = paths.slice(0, 5).map(baseName).join(", ");
      const more = paths.length > 5 ? `, and ${paths.length - 5} more` : "";
      const yes = await askConfirm({
        title: many ? `Delete ${paths.length} items?` : `Delete ${folder ? "folder" : "file"}?`,
        body: many
          ? `This permanently deletes ${paths.length} items: ${names}${more}. It can't be undone.`
          : `This permanently deletes ${baseName(paths[0])}${folder ? " and everything in it" : ""}. It can't be undone.`,
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (!yes) return;
      // A folder takes its contents with it — don't delete those twice.
      const top: string[] = [];
      for (const p of [...paths].sort())
        if (!top.some((t) => p === t || p.startsWith(t + "/"))) top.push(p);
      const failed: string[] = [];
      for (const p of top) await fsDelete(p).catch((e) => failed.push(String(e)));
      if (top.length === 1) await relist(folderOf(root, top[0]));
      else await relistAll(true);
      if (failed.length > 0) throw new Error(failed.join("\n"));
    });

  const discard = (path: string, untracked: boolean) =>
    attempt(async () => {
      const rel = relativeTo(root, path);
      const yes = await askConfirm({
        title: "Discard changes?",
        body: untracked
          ? `Delete ${rel}. It is a new file, so nothing brings it back.`
          : `Put ${rel} back to how it was at the last commit.`,
        confirmLabel: "Discard changes",
        tone: "danger",
      });
      if (!yes) return;
      await gitDiscard(root, [rel]);
      await relist(folderOf(root, path));
    });

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  return {
    problem,
    create,
    rename,
    move,
    remove,
    discard,
    copyPath: (path: string) => copy(path),
    copyRelativePath: (path: string) => copy(relativeTo(root, path)),
    reveal: (path: string) => void attempt(() => api.fsRevealInFinder(path)),
    openIn: (path: string, editorId: string) => void attempt(() => api.editorOpen(path, editorId)),
    attach: attachToChat,
  };
}

/** Put a file in the chat box — the same hand-over a drop on it makes. */
export function attachToChat(path: string): void {
  window.dispatchEvent(
    new CustomEvent(OS_FILE_DROP_COMPOSER, { detail: { paths: [path], targetId: null } }),
  );
}

/** The installed editors for "Open in", probed once. Empty until it answers,
 *  and empty for good when `wanted` is false (a tree on a machine: those
 *  apps run here and cannot open a file over there). */
export function useEditors(wanted: boolean): EditorInfo[] {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    api
      .editorsList()
      .then((list) => {
        if (alive) setEditors(list);
      })
      .catch(() => {
        /* none surfaced — "Open in" stays unavailable */
      });
    return () => {
      alive = false;
    };
  }, [wanted]);
  return editors;
}
