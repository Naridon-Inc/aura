// Live title/url store for in-app browser workpane tabs.
//
// A `{ kind: "browser" }` pane is a real native WebKit webview (owned by
// Rust, keyed by the tab id — see lib/browserEngine.ts). Its page title and
// current url live in that native layer, not in editorStore, so the tab pill
// can't read them the way it reads a file name or an agent label.
//
// The BrowserTab component pushes each navigation's title+url+loading here as
// the native `browser:state` events arrive; the WorkSurface tab strip
// subscribes via `useBrowserTabTitles()` and labels each browser pill with the
// live page title (falling back to the host). Mirrors pagesActiveTitle.ts:
// a useSyncExternalStore feed with an identity-stable snapshot so unchanged
// titles don't re-render the strip.

import { useSyncExternalStore } from "react";

export type BrowserTabMeta = {
  /** Page <title>, or "" before the first settled load. */
  title: string;
  /** Current committed url (tracks redirects + back/forward). */
  url: string;
  /** True between a navigation start and the page settling. */
  loading: boolean;
};

const meta = new Map<string, BrowserTabMeta>();
// Identity-stable snapshot: a fresh object only when something actually
// changed, so useSyncExternalStore consumers don't loop.
let snapshot: Record<string, BrowserTabMeta> = {};
const subs = new Set<() => void>();

function rebuild(): void {
  const next: Record<string, BrowserTabMeta> = {};
  for (const [id, m] of meta) next[id] = m;
  snapshot = next;
}

function emit(): void {
  for (const fn of subs) fn();
}

/** Record the live title/url/loading for a browser tab. No-ops when nothing
 *  changed so the tab strip only re-renders on a real update. */
export function setBrowserTabMeta(id: string, m: BrowserTabMeta): void {
  const prev = meta.get(id);
  if (
    prev &&
    prev.title === m.title &&
    prev.url === m.url &&
    prev.loading === m.loading
  ) {
    return;
  }
  meta.set(id, m);
  rebuild();
  emit();
}

/** Drop a browser tab's meta when its webview is reaped. */
export function clearBrowserTabMeta(id: string): void {
  if (!meta.delete(id)) return;
  rebuild();
  emit();
}

/** Non-reactive read (for imperative callers). */
export function getBrowserTabMeta(id: string): BrowserTabMeta | undefined {
  return meta.get(id);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function getSnapshot(): Record<string, BrowserTabMeta> {
  return snapshot;
}

/** Live map of browser-tab id → {title,url,loading}. Identity-stable between
 *  changes. */
export function useBrowserTabTitles(): Record<string, BrowserTabMeta> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
