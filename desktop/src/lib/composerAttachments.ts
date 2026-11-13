// Hands a file to the composer of one conversation, from outside it.
//
// A new chat offers earlier chats and plans to attach before the first
// message. The chips live above the transcript; the attachments belong to the
// composer under it. Each composer registers itself under its session id, so a
// split view with two chats attaches to the one the chip was in, and the chips
// can show which of them are already attached.

type Attacher = {
  attach: (file: File) => void;
  names: () => string[];
  /** Take a waiting file back out by name. */
  remove?: (name: string) => void;
};

const attachers = new Map<string, Attacher>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Register a composer for `sessionId`. Returns an unregister function that
 *  only clears the entry if it still points at this composer. */
export function registerComposerAttacher(sessionId: string, attacher: Attacher): () => void {
  // Re-inserted so the map's last key is the composer that came up last.
  attachers.delete(sessionId);
  attachers.set(sessionId, attacher);
  emit();
  return () => {
    if (attachers.get(sessionId) === attacher) {
      attachers.delete(sessionId);
      emit();
    }
  };
}

/** Attach `file` to the composer of `sessionId`. False when that composer is
 *  not mounted. */
export function attachToComposer(sessionId: string, file: File): boolean {
  const a = attachers.get(sessionId);
  if (!a) return false;
  a.attach(file);
  return true;
}

/** Take the file called `name` back out of the composer of `sessionId`.
 *  False when that composer is not mounted or cannot remove. */
export function detachFromComposer(sessionId: string, name: string): boolean {
  const a = attachers.get(sessionId);
  if (!a?.remove) return false;
  a.remove(name);
  return true;
}

/** The session of the composer mounted last — the chat a surface with no
 *  chat of its own (a diff, say) hands things to. Null with none mounted. */
export function latestComposerSession(): string | null {
  let last: string | null = null;
  for (const key of attachers.keys()) last = key;
  return last;
}

/** The names of the files waiting in the composer of `sessionId`, joined by a
 *  newline so the value is stable between renders. */
export function composerAttachmentKey(sessionId: string): string {
  return attachers.get(sessionId)?.names().join("\n") ?? "";
}

/** Called by a composer whenever its attachments change. */
export function notifyComposerAttachments(): void {
  emit();
}

export function subscribeComposerAttachments(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
