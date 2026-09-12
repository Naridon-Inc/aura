// "Reset chat" — start this conversation over, optionally throwing away the
// uncommitted file changes along with it.
//
// The old conversation is not deleted: it stays in Chat history like any
// closed chat. A fresh chat opens in its place, through the same door ⌘N
// uses, on the same project (and the same connected machine, if the chat
// was working on one). "Also reset files" is the destructive half, so it is
// asked about separately and in red.

import { api } from "./api";
import { askConfirm } from "../components/ui/ask";
import { openManagerSession } from "./editorStore";
import { getManagerSession } from "./managerStore";
import { gitResetFiles } from "./place/workApi";
import { toast } from "./toast";

/** Roots the chat may work in; the first is the one the fresh chat opens on. */
export function sessionRoots(session: { projects: { root: string }[] } | null | undefined): string[] {
  return (session?.projects ?? []).map((p) => p.root).filter((r) => r.length > 0);
}

/** Throw away every uncommitted change in `repoRoot` — tracked files go back
 *  to the last commit, untracked files and folders are removed. Resolves to
 *  how many files were affected. Wherever the checkout is: a chat working on
 *  a machine resets the box's copy (AURA-1306). */
export async function resetFiles(repoRoot: string): Promise<number> {
  return gitResetFiles(repoRoot);
}

/** Ask, then reset. Resolves to the NEW session id once it is open, or null
 *  when the user declined or nothing could be started. The caller closes the
 *  old tab — that needs the store hook, which this module doesn't hold. */
export async function resetChatFromTab(
  sessionId: string,
  opts: { alsoFiles: boolean; fileCount?: number | null },
): Promise<string | null> {
  const session = getManagerSession(sessionId) ?? (await api.managerStatus(sessionId));
  const roots = sessionRoots(session);
  const root = roots[0];
  if (!root) {
    toast.info("Can't reset this chat", "It isn't attached to a project.");
    return null;
  }

  const n = opts.fileCount;
  const ok = await askConfirm(
    opts.alsoFiles
      ? {
          title: "Start over and discard your file changes?",
          body:
            (n != null && n > 0 ? `${n} changed file${n === 1 ? "" : "s"} will go back to the last commit and new files will be deleted. ` : "Every uncommitted change will go back to the last commit and new files will be deleted. ") +
            "This can't be undone. The conversation moves to Chat history and a fresh chat opens in its place.",
          confirmLabel: "Discard changes and start over",
          tone: "danger",
        }
      : {
          title: "Start this chat over?",
          body: "The conversation moves to Chat history and a fresh chat opens in its place. Your files are left as they are.",
          confirmLabel: "Start over",
        },
  );
  if (!ok) return null;

  if (opts.alsoFiles) {
    try {
      const count = await resetFiles(root);
      toast.success(
        count === 0 ? "Nothing to discard" : `Discarded changes in ${count} file${count === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.show({
        title: "Couldn't reset the files",
        message: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
      return null;
    }
  }

  try {
    const fresh = await api.managerChatStart(
      root,
      "",
      session?.machine_id ?? null,
      roots.length > 1 ? roots : undefined,
    );
    openManagerSession(fresh, "Aura");
    return fresh;
  } catch (e) {
    toast.show({
      title: "Couldn't start a fresh chat",
      message: e instanceof Error ? e.message : String(e),
      tone: "danger",
    });
    return null;
  }
}
