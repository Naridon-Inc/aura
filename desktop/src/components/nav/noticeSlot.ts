import { useSyncExternalStore } from "react";

// Where the app-level notices are drawn: the sidebar registers the element
// at its foot while it is on screen, and clears it when it goes away.

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setNoticeSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useNoticeSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot);
}
