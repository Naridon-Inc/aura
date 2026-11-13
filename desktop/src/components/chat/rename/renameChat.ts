// Renaming a chat from anywhere: a request to open the dialog, and the rename
// itself — the backend first, then every place in the app that shows the name.

import { api } from "../../../lib/api";
import { renameManagerTabById } from "../../../lib/editorStore";
import { applyManagerRename } from "../../../lib/managerStore";

export const RENAME_CHAT_EVENT = "aura:chat:rename";

export type RenameChatRequest = { sessionId: string; currentTitle: string };

/** Ask the mounted rename dialog to open for one chat. */
export function requestRenameChat(sessionId: string, currentTitle: string): void {
  window.dispatchEvent(
    new CustomEvent<RenameChatRequest>(RENAME_CHAT_EVENT, {
      detail: { sessionId, currentTitle },
    }),
  );
}

/** The same rule the backend applies: one line, runs of whitespace collapsed,
 *  at most 100 characters; null when nothing is left. */
export function cleanChatTitle(raw: string): string | null {
  const oneLine = raw.split(/\s+/).filter(Boolean).join(" ");
  if (!oneLine) return null;
  return Array.from(oneLine).slice(0, 100).join("");
}

/** What a rename touches: the saved session, the chat list, the open tab. */
export type RenameChatEffects = {
  save: (sessionId: string, title: string) => Promise<void>;
  updateList: (sessionId: string, title: string) => void;
  updateTab: (sessionId: string, title: string) => void;
};

const appEffects: RenameChatEffects = {
  save: (sessionId, title) => api.managerRename(sessionId, title),
  updateList: applyManagerRename,
  updateTab: renameManagerTabById,
};

/** Rename a chat. Resolves to the name it now has, or null when the name was
 *  blank or unchanged and nothing was done. The list and the tab change only
 *  once the name is saved, so a failed save leaves the old name everywhere. */
export async function renameChat(
  sessionId: string,
  raw: string,
  currentTitle: string,
  effects: RenameChatEffects = appEffects,
): Promise<string | null> {
  const title = cleanChatTitle(raw);
  if (!title || title === currentTitle.trim()) return null;
  await effects.save(sessionId, title);
  effects.updateList(sessionId, title);
  effects.updateTab(sessionId, title);
  return title;
}
