// Copy a chat's transcript to the clipboard, from the chat tab's menu or ⌘⌥C.
// The conversation is read fresh from the backend, so a copy taken while a
// tab is still loading has every turn rather than the ones drawn so far.

import { api } from "./api";
import {
  chatTranscriptText,
  copiedTranscriptMessage,
  type TranscriptMode,
} from "./chatTranscriptMarkdown";
import { writeClipboardText } from "./clipboard";
import { toast } from "./toast";

/** Chats with a copy under way; a second press waits for the first. */
const copying = new Set<string>();

export async function copyChatTranscript(
  sessionId: string,
  title: string,
  mode: TranscriptMode,
): Promise<void> {
  if (copying.has(sessionId)) return;
  copying.add(sessionId);
  try {
    const session = await api.managerStatus(sessionId);
    const text = chatTranscriptText(session.chat ?? [], mode);
    if (!text?.trim()) {
      toast.warning("No chat content to copy");
      return;
    }
    if (!(await writeClipboardText(text))) throw new Error("clipboard refused the write");
    toast.success(copiedTranscriptMessage(mode, title));
  } catch {
    toast.danger(`Failed to copy ${mode} transcript`);
  } finally {
    copying.delete(sessionId);
  }
}

/** ⌘⌥C: a concise copy of whichever chat is in front. Quietly does nothing
 *  when the active tab isn't a chat. */
export async function copyActiveChatTranscript(s: {
  activeManagerId: string | null;
  managerTabs: { sessionId: string; label: string }[];
}): Promise<void> {
  const id = s.activeManagerId;
  if (!id) return;
  const title = s.managerTabs.find((t) => t.sessionId === id)?.label ?? "";
  await copyChatTranscript(id, title, "concise");
}
