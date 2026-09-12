// "Mark as unread" — a hand-set flag on a chat tab.
//
// The tab strip already knows when a chat NEEDS you (a question, a plan).
// This is the other direction: you looked, you're not ready to deal with it,
// and you want the tab to keep saying "come back" until you do. The flag
// clears itself the moment the tab is raised again, which is what unread
// means everywhere else. Kept in storage so a reload doesn't forget.

import { useSyncExternalStore } from "react";

const KEY = "aura.tabs.unread";
const EVENT = "aura:tab-unread-changed";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

let unread: Set<string> = load();

function save(): void {
  try {
    if (unread.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...unread]));
  } catch {
    /* storage disabled */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function isTabUnread(id: string): boolean {
  return unread.has(id);
}

export function markTabUnread(id: string): void {
  if (unread.has(id)) return;
  unread = new Set(unread).add(id);
  save();
}

export function clearTabUnread(id: string): void {
  if (!unread.has(id)) return;
  unread = new Set(unread);
  unread.delete(id);
  save();
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Live read of the flag for one tab. */
export function useTabUnread(id: string): boolean {
  return useSyncExternalStore(subscribe, () => unread.has(id), () => false);
}
