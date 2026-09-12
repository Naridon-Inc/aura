// "Fork chat" from a tab's menu or ⌘⌥↩ — no message picked, so it branches
// at the latest settled reply and opens the copy in a new tab.
//
// The per-message fork already exists (`api.managerForkSession` with the
// index of the bubble you chose). This reuses it: the only new decision is
// which index, and `forkPoint.ts` makes it.

import { api } from "./api";
import { openManagerSession } from "./editorStore";
import { latestSettledTurnIndex } from "./forkPoint";
import { getManagerSession } from "./managerStore";
import { toast } from "./toast";

/** Fork `sessionId` at its latest settled reply and raise the copy. Resolves
 *  to the new session id, or null when there was nothing to fork yet. */
export async function forkChatFromTab(sessionId: string): Promise<string | null> {
  const session = getManagerSession(sessionId) ?? (await api.managerStatus(sessionId));
  const at = latestSettledTurnIndex(session?.chat);
  if (at < 0) {
    toast.info("Nothing to fork yet", "Wait for Aura's first reply, then fork from there.");
    return null;
  }
  try {
    const forked = await api.managerForkSession(sessionId, at);
    const label = (session?.objective?.trim() || "Aura") + " (fork)";
    openManagerSession(forked, label);
    return forked;
  } catch (e) {
    toast.show({
      title: "Couldn't fork this chat",
      message: e instanceof Error ? e.message : String(e),
      tone: "danger",
    });
    return null;
  }
}

/** ⌘⌥↩: fork whichever chat is in front. Quietly does nothing when the
 *  active tab isn't a chat. */
export async function forkActiveChat(s: { activeManagerId: string | null }): Promise<void> {
  if (!s.activeManagerId) return;
  await forkChatFromTab(s.activeManagerId);
}
