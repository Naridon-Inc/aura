// Active-page title store for the Pages workpane tab.
//
// The Pages surface (PagesSurface) is one deduped workpane keyed by
// repoRoot, so there is a single "Pages" tab. Its label used to be the
// static word "Pages". This store lets that tab pill instead read the
// title of whichever page is currently open, falling back to "Pages"
// when nothing is open yet.
//
// Mechanism: PagesSurface broadcasts `{ summaries, activeKey }` on the
// window event `aura:pages:summaries` whenever its list or selection
// changes. We listen here and resolve activeKey → that page's title. A
// useSyncExternalStore hook (matching callActivity.ts) feeds the tab
// strip; the snapshot is identity-stable when the title is unchanged so
// React doesn't loop.
//
// Note the active page is per-repo via summaries, but the tab strip only
// ever shows the current repo's pages pane, so a single global "active
// title" is the right granularity here — no per-repoRoot keying needed.

import { useSyncExternalStore } from "react";

/** Subset of the broadcast NoteSummary shape we need to resolve a title.
 *  Kept local so this store never imports the pages2/* module another
 *  agent owns. */
type PageSummaryLike = {
  id: string;
  scope: string;
  bucket: string;
  title: string;
};

type SummariesEventDetail = {
  summaries: PageSummaryLike[];
  activeKey: string | null;
};

/** Composite key as built by pages2/pagesApi.ts `pageKey`. */
function keyOf(s: PageSummaryLike): string {
  return `${s.scope}|${s.bucket}|${s.id}`;
}

// Current active title, or null when no page is open / no title resolves.
let activeTitle: string | null = null;
const subs = new Set<() => void>();
let listening = false;

function emit(): void {
  for (const fn of subs) fn();
}

function onSummaries(e: Event): void {
  const detail = (e as CustomEvent<SummariesEventDetail>).detail;
  if (!detail) return;
  const { summaries, activeKey } = detail;
  let next: string | null = null;
  if (activeKey && Array.isArray(summaries)) {
    const match = summaries.find((s) => keyOf(s) === activeKey);
    if (match) {
      const trimmed = (match.title ?? "").trim();
      next = trimmed.length > 0 ? trimmed : "Untitled";
    }
  }
  // Identity-stable: only emit when the resolved title actually changes,
  // so subscribers don't re-render on every summaries broadcast.
  if (next === activeTitle) return;
  activeTitle = next;
  emit();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("aura:pages:summaries", onSummaries as EventListener);
    listening = true;
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && listening && typeof window !== "undefined") {
      window.removeEventListener("aura:pages:summaries", onSummaries as EventListener);
      listening = false;
    }
  };
}

function getSnapshot(): string | null {
  return activeTitle;
}

/** Live title of the currently-open page, or null when none is open. */
export function usePagesActiveTitle(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
