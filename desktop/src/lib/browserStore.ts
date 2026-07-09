// Tab state for the in-app browser. Mirrors the lightweight module-store
// pattern used across `src/lib/*Store.ts` (a cache + subscriber Set surfaced
// through `useSyncExternalStore`).
//
// Division of labour: this store owns tab METADATA (url, title, loading, order,
// active) and persists it. The native webview LIFECYCLE (create/position/show/
// hide) lives in the rail component, which has the on-screen rect. The two stay
// in sync through:
//   • `navSeq` — bumped only on a user-initiated `go()`. The reconciler in the
//     component navigates the webview when a tab's navSeq exceeds the last one
//     it acted on, so a server redirect (which updates `url` via `applyState`
//     WITHOUT bumping navSeq) is never echoed back as a fresh navigation.
//   • `created` — the set of tab ids that currently have a live native webview.
//     Not persisted: native webviews don't survive a full app reload, so a
//     restored tab is re-opened lazily on its first reconcile.

import { useSyncExternalStore } from "react";

import {
  browserBack,
  browserClose,
  browserForward,
  browserReload,
  normalizeUrl,
  type BrowserStateEvent,
} from "./browserEngine";

export type BrowserTab = {
  id: string;
  /** Normalized destination; "" means the start page (quick links). */
  url: string;
  title: string;
  loading: boolean;
  /** Monotonic per-tab counter; bumped only by user navigation. */
  navSeq: number;
};

type State = { tabs: BrowserTab[]; activeId: string | null };

const KEY = "aura.browser.tabs.v2";

type Persisted = { tabs: { id: string; url: string; title: string }[]; activeId: string | null };

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const tabs: BrowserTab[] = (parsed.tabs ?? []).map((t) => ({
      id: t.id,
      url: t.url ?? "",
      title: t.title ?? "",
      loading: false,
      // A restored tab with a destination must re-open on first reconcile, so
      // it starts at navSeq 1 (empty start-page tabs stay at 0).
      navSeq: t.url ? 1 : 0,
    }));
    const activeId =
      parsed.activeId && tabs.some((t) => t.id === parsed.activeId)
        ? parsed.activeId
        : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

let cache: State = read();
const subs = new Set<() => void>();
/** Tab ids with a live native webview. Module-level, not persisted. */
const created = new Set<string>();

function persist() {
  try {
    const data: Persisted = {
      tabs: cache.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
      activeId: cache.activeId,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore quota / private mode */
  }
}

function emit() {
  persist();
  for (const fn of subs) fn();
}

function setState(next: State) {
  cache = next;
  emit();
}

function newId(): string {
  return crypto.randomUUID();
}

export function getBrowserState(): State {
  return cache;
}

/** Open a new tab. With a `url` it loads immediately; without one it shows the
 *  start page. Returns the new tab id and makes it active. */
export function newTab(url = ""): string {
  const normalized = url ? normalizeUrl(url) : "";
  const tab: BrowserTab = {
    id: newId(),
    url: normalized,
    title: "",
    loading: Boolean(normalized),
    navSeq: normalized ? 1 : 0,
  };
  setState({ tabs: [...cache.tabs, tab], activeId: tab.id });
  return tab.id;
}

/** Close a tab, tearing down its native webview and picking a neighbour to
 *  activate. */
export function closeTab(id: string): void {
  void browserClose(id).catch(() => {});
  created.delete(id);
  const idx = cache.tabs.findIndex((t) => t.id === id);
  const tabs = cache.tabs.filter((t) => t.id !== id);
  let activeId = cache.activeId;
  if (activeId === id) {
    const neighbour = tabs[Math.max(0, idx - 1)] ?? tabs[0] ?? null;
    activeId = neighbour ? neighbour.id : null;
  }
  setState({ tabs, activeId });
}

export function setActiveTab(id: string): void {
  if (cache.activeId === id) return;
  setState({ ...cache, activeId: id });
}

/** Hand a tab off to a popout window: drop it from the rail and forget its
 *  native webview WITHOUT closing it. The webview is reparented (live) into the
 *  popout, which owns its lifecycle from now on — so the rail must not hide,
 *  reposition, or destroy it. Mirrors `closeTab` minus the `browserClose`. */
export function detachTab(id: string): void {
  created.delete(id);
  const idx = cache.tabs.findIndex((t) => t.id === id);
  const tabs = cache.tabs.filter((t) => t.id !== id);
  let activeId = cache.activeId;
  if (activeId === id) {
    const neighbour = tabs[Math.max(0, idx - 1)] ?? tabs[0] ?? null;
    activeId = neighbour ? neighbour.id : null;
  }
  setState({ tabs, activeId });
}

/** User navigation from the address bar or a quick link. Normalizes the input,
 *  marks the tab loading, and bumps navSeq so the reconciler drives the
 *  webview. No-op on empty input. */
export function go(id: string, input: string): void {
  const url = normalizeUrl(input);
  if (!url) return;
  setState({
    ...cache,
    tabs: cache.tabs.map((t) =>
      t.id === id ? { ...t, url, loading: true, navSeq: t.navSeq + 1 } : t,
    ),
  });
}

export function back(id: string): void {
  if (created.has(id)) void browserBack(id).catch(() => {});
}

export function forward(id: string): void {
  if (created.has(id)) void browserForward(id).catch(() => {});
}

export function reload(id: string): void {
  if (!created.has(id)) return;
  void browserReload(id).catch(() => {});
  setState({
    ...cache,
    tabs: cache.tabs.map((t) => (t.id === id ? { ...t, loading: true } : t)),
  });
}

/** Fold a `browser:state` event into the matching tab. Never touches navSeq —
 *  redirects update the URL without provoking a re-navigation. */
export function applyBrowserState(ev: BrowserStateEvent): void {
  if (!cache.tabs.some((t) => t.id === ev.tabId)) return;
  setState({
    ...cache,
    tabs: cache.tabs.map((t) =>
      t.id === ev.tabId
        ? { ...t, url: ev.url || t.url, title: ev.title ?? t.title, loading: ev.loading }
        : t,
    ),
  });
}

export function markCreated(id: string): void {
  created.add(id);
}

/** Drop the live-webview flag — used when an open fails so the next reconcile
 *  retries instead of assuming the webview exists. */
export function unmarkCreated(id: string): void {
  created.delete(id);
}

export function isCreated(id: string): boolean {
  return created.has(id);
}

export function useBrowserStore(): State {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => cache,
    () => cache,
  );
}

// ── Recent searches ─────────────────────────────────────────────────────────
// Kept separate from tab State so the existing `setState({ tabs, activeId })`
// calls never need to thread it through. Powers the Arc-style start page.
const RECENTS_KEY = "aura.browser.recents.v1";
const RECENTS_CAP = 8;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let recents: string[] = readRecents();
const recentSubs = new Set<() => void>();

/** Record a search/query for the start-page suggestion list (most-recent first,
 *  de-duped, capped). No-op on empty input. */
export function pushRecentSearch(query: string): void {
  const s = query.trim();
  if (!s) return;
  recents = [s, ...recents.filter((r) => r !== s)].slice(0, RECENTS_CAP);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    /* ignore quota / private mode */
  }
  for (const fn of recentSubs) fn();
}

export function useRecentSearches(): string[] {
  return useSyncExternalStore(
    (cb) => {
      recentSubs.add(cb);
      return () => recentSubs.delete(cb);
    },
    () => recents,
    () => recents,
  );
}

/** The active tab object, or null when no tab is open. */
export function useActiveBrowserTab(): BrowserTab | null {
  const { tabs, activeId } = useBrowserStore();
  return tabs.find((t) => t.id === activeId) ?? null;
}
