// "Does this tab have something half-typed in it?" — live, for the tab strip.
//
// Drafts live in localStorage under a per-conversation key. The strip can't
// poll storage on every render, and `storage` events only fire in other
// windows, so `writeDraft` announces each change on the window and this hook
// subscribes to that. The answer is a boolean, not the text: the strip only
// draws a pencil.

import { useSyncExternalStore } from "react";

import { DRAFT_CHANGED_EVENT, readDraft } from "../components/composer/composerDrafts";

/** Pure: a draft counts when it has anything but whitespace in it. */
export function hasDraftText(text: string | null | undefined): boolean {
  return !!text && text.trim().length > 0;
}

function subscribe(key: string, onChange: () => void): () => void {
  const onLocal = (e: Event) => {
    if ((e as CustomEvent<string>).detail === key) onChange();
  };
  const onRemote = (e: StorageEvent) => {
    if (e.key === key || e.key === null) onChange();
  };
  window.addEventListener(DRAFT_CHANGED_EVENT, onLocal);
  window.addEventListener("storage", onRemote);
  return () => {
    window.removeEventListener(DRAFT_CHANGED_EVENT, onLocal);
    window.removeEventListener("storage", onRemote);
  };
}

/** True while the draft stored under `key` has text in it. */
export function useHasDraft(key: string): boolean {
  return useSyncExternalStore(
    (cb) => subscribe(key, cb),
    () => hasDraftText(readDraft(key)),
    () => false,
  );
}
