// Routes externally-sourced text into the composer the user last touched.
//
// Some surfaces produce prompt context from outside the chat — today the
// in-app browser's Agentation (click elements on a page, attach them to the
// next message). A naive `window` CustomEvent would fan out to EVERY mounted
// composer, so a split view with two chats would double-insert. Instead this is
// a module singleton: each composer registers its inserter on mount and again
// on focus, so `active` always points at the one the user is actually working
// in. The latest registrant wins; unmount clears it only if it's still current.

/** Where incoming text goes: after what is typed (an attachment, a quote),
 *  or in front of it (an @mention, which addresses the whole message). */
export type InsertAt = "end" | "start";

type Inserter = (text: string, at?: InsertAt) => void;

/** `insert` put in front of the draft, once: a draft that already starts
 *  with it is left alone. */
export function withLeading(draft: string, insert: string): string {
  const lead = insert.trim();
  if (!lead) return draft;
  const rest = draft.trimStart();
  if (rest.toLowerCase().startsWith(lead.toLowerCase())) {
    const after = rest.slice(lead.length);
    if (!after || /^[\s,:;]/.test(after)) return draft;
  }
  return rest ? `${lead} ${rest}` : `${lead} `;
}

/** `insert` after the draft, a blank line between them. */
export function withTrailing(draft: string, insert: string): string {
  const add = insert.trim();
  if (!add) return draft;
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${add}` : add;
}

let active: Inserter | null = null;

/** Register (or re-assert) this composer as the insert target. Returns an
 *  unregister fn that only clears `active` if it still points here — so a
 *  later composer taking focus is never clobbered by an earlier one's cleanup. */
export function registerComposerInserter(fn: Inserter): () => void {
  active = fn;
  return () => {
    if (active === fn) active = null;
  };
}

/** Insert text into the active composer. Returns false when no composer is
 *  mounted (e.g. the chat pane is closed), so callers can fall back. */
export function insertIntoComposer(text: string, at: InsertAt = "end"): boolean {
  if (!active) return false;
  try {
    active(text, at);
    return true;
  } catch {
    return false;
  }
}
