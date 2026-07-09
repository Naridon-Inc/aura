// Registry + enabled-state for Commons **builtin** apps.
//
// A builtin app is Aura's own first-party code (Reddit, …) rendered directly
// in the `app` workpane — distinct from third-party plugin apps, which load
// sandboxed HTML from `contributes.apps[]`. Builtins carry the appKey
// `builtin:<id>`; `AppPaneSurface` recognizes that prefix and mounts the
// matching React surface instead of a `PluginSandboxFrame`.
//
// "Enabling" a builtin is a one-bit, local preference (it doesn't install
// anything — the code already ships): the id is added to a persisted set so
// the app shows up under "Your apps" and survives a reload. The set is a
// plain localStorage list with a tiny subscribe hook so the launcher updates
// live the instant you enable one.

import { useSyncExternalStore } from "react";

export type BuiltinAppDef = {
  /** Stable id; the `<id>` half of a `builtin:<id>` appKey. */
  id: string;
  title: string;
  /** Brand logo served from `public/app-icons/`. */
  logo: string;
  /** True when the app is fully implemented and can be opened today. A
   *  not-ready builtin is listed (with its real logo) but shows a calm
   *  "Soon" affordance instead of a dead Enable button — never a stub. */
  ready: boolean;
};

/** Every builtin app, keyed by id. Reddit is live today (public API, no
 *  credentials). Gemini + Gmail are listed with real branding but gated
 *  until their real integrations land — honest over fake. */
export const BUILTIN_APPS: Record<string, BuiltinAppDef> = {
  reddit: {
    id: "reddit",
    title: "Reddit",
    logo: "/app-icons/reddit.svg",
    ready: true,
  },
  hackernews: {
    id: "hackernews",
    title: "Hacker News",
    logo: "/app-icons/hackernews.svg",
    ready: true,
  },
  gemini: {
    id: "gemini",
    title: "Gemini",
    logo: "/app-icons/gemini.svg",
    ready: false,
  },
  gmail: {
    id: "gmail",
    title: "Gmail",
    logo: "/app-icons/gmail.svg",
    ready: false,
  },
};

/** The `app`-pane key a builtin opens under. */
export function builtinAppKey(id: string): string {
  return `builtin:${id}`;
}

/** Extract the builtin id from a `builtin:<id>` appKey, or null if the key
 *  isn't a builtin (a plugin `<pluginId>:<appId>` key). */
export function builtinIdFromKey(appKey: string): string | null {
  return appKey.startsWith("builtin:") ? appKey.slice("builtin:".length) : null;
}

export function getBuiltinApp(id: string): BuiltinAppDef | undefined {
  return BUILTIN_APPS[id];
}

// ── enabled-set store ──────────────────────────────────────────────────

const LS_KEY = "aura.commons.enabledBuiltins";
const listeners = new Set<() => void>();
let cache: string[] = readRaw();

function readRaw(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (x): x is string => typeof x === "string" && x in BUILTIN_APPS,
        )
      : [];
  } catch {
    return [];
  }
}

function emit() {
  cache = readRaw();
  for (const l of listeners) l();
}

/** Whether a builtin is in the user's enabled set. */
export function isBuiltinEnabled(id: string): boolean {
  return cache.includes(id);
}

/** Add a builtin to the enabled set (idempotent). Ready apps only — a
 *  not-ready id is ignored so "Soon" tiles can never half-enable. */
export function enableBuiltin(id: string): void {
  if (!BUILTIN_APPS[id]?.ready || cache.includes(id)) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...cache, id]));
  } catch {
    /* storage full / unavailable — enable is best-effort */
  }
  emit();
}

/** Remove a builtin from the enabled set (idempotent). */
export function disableBuiltin(id: string): void {
  if (!cache.includes(id)) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache.filter((x) => x !== id)));
  } catch {
    /* ignore */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Cross-window (popout) sync: another window writing the key fires storage.
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** Reactive list of enabled builtin ids — re-renders on enable/disable. */
export function useEnabledBuiltins(): string[] {
  return useSyncExternalStore(subscribe, () => cache);
}
