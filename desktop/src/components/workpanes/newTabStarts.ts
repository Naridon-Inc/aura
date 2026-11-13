// The three things a workspace's ＋ and an empty pane start: a chat, a
// terminal, a browser. Each one opens its tab and hands its ref to `place`,
// which decides where it lands — a new tab on a pane, or the slot of the empty
// pane it was started from.

import { placeForNewWork, writeAmbientSid } from "../../lib/ambientSession";
import { api } from "../../lib/api";
import { newBrowserTabId, type WorkPaneRef } from "../../lib/editorStore";
import { toast } from "../../lib/toast";

export type Place = (ref: WorkPaneRef) => void;

type Opens = {
  openManager: (sessionId: string, label: string) => void;
  openTerminal: (cwd: string, opts?: { label?: string }) => string;
};

/** A blank chat about this workspace, on the machine the workspace is on —
 *  the same start ⌘N makes. */
export async function startChat(store: Opens, repoRoot: string, place: Place) {
  try {
    const where = placeForNewWork(repoRoot);
    const sid = await api.managerChatStart(repoRoot, "", where ?? undefined);
    store.openManager(sid, "New chat");
    writeAmbientSid(repoRoot, where, sid);
    place({ kind: "manager", id: sid });
  } catch (e) {
    toast.danger("Couldn't start a chat", String(e));
  }
}

export function startTerminal(store: Opens, repoRoot: string, place: Place) {
  const id = store.openTerminal(repoRoot, { label: "Terminal" });
  place({ kind: "terminal", id });
}

export function startBrowser(place: Place) {
  place({ kind: "browser", id: newBrowserTabId() });
}
