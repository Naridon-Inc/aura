// Modes store — mirrors `mcpToolsStore.ts` but for the installed +
// marketplace mode catalogues. The composer chip + Settings → Modes
// pane + the marketplace dialog all read from this single source so
// the picker stays consistent.
//
// Two refresh paths:
//
// - `refreshInstalledModes()` reads `~/.aura/modes/*.yaml` via the
//   Tauri `modes_list_installed` command. Cheap and synchronous on
//   the Rust side; coalesces concurrent callers.
// - `refreshMarketplace()` hits `https://auravcs.com/marketplace/modes.json`
//   via the Rust marketplace client. Slower (5s timeout) so the
//   marketplace dialog renders an explicit loading state.
//
// Both share the same module-level store so the marketplace card can
// flip from "Install" to "Update Available" without an extra refresh.

import { useSyncExternalStore } from "react";

import {
  api,
  type MarketplaceIndex,
  type ModeDescriptor,
  type ModeUpdateRow,
} from "./api";

type StoreShape = {
  installed: ModeDescriptor[];
  installedLoadedAt: number | null;
  installedError: string | null;
  installedLoading: boolean;

  marketplace: MarketplaceIndex | null;
  marketplaceLoadedAt: number | null;
  marketplaceError: string | null;
  marketplaceLoading: boolean;

  updates: ModeUpdateRow[];
  updatesLoadedAt: number | null;

  /** Active mode the composer chip injects into every turn. `null` =
   *  no mode (default brain behaviour). Persists in localStorage. */
  activeSlug: string | null;
};

const ACTIVE_SLUG_KEY = "aura.modes.activeSlug";

function loadActiveSlug(): string | null {
  try {
    return (
      window.localStorage.getItem(ACTIVE_SLUG_KEY) || null
    );
  } catch {
    return null;
  }
}

function saveActiveSlug(slug: string | null) {
  try {
    if (slug) window.localStorage.setItem(ACTIVE_SLUG_KEY, slug);
    else window.localStorage.removeItem(ACTIVE_SLUG_KEY);
  } catch {
    // ignore
  }
}

const state: StoreShape = {
  installed: [],
  installedLoadedAt: null,
  installedError: null,
  installedLoading: false,
  marketplace: null,
  marketplaceLoadedAt: null,
  marketplaceError: null,
  marketplaceLoading: false,
  updates: [],
  updatesLoadedAt: null,
  activeSlug: loadActiveSlug(),
};

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): StoreShape {
  return state;
}

let installedInflight: Promise<void> | null = null;
let marketplaceInflight: Promise<void> | null = null;

export function refreshInstalledModes(): Promise<void> {
  if (installedInflight) return installedInflight;
  state.installedLoading = true;
  emit();
  installedInflight = (async () => {
    try {
      const rows = await api.modesListInstalled();
      state.installed = rows;
      state.installedLoadedAt = Date.now();
      state.installedError = null;
    } catch (e) {
      state.installedError = String(e);
    } finally {
      state.installedLoading = false;
      installedInflight = null;
      emit();
    }
  })();
  return installedInflight;
}

export function refreshMarketplace(): Promise<void> {
  if (marketplaceInflight) return marketplaceInflight;
  state.marketplaceLoading = true;
  emit();
  marketplaceInflight = (async () => {
    try {
      const idx = await api.modesMarketplaceList();
      state.marketplace = idx;
      state.marketplaceLoadedAt = Date.now();
      state.marketplaceError = null;
    } catch (e) {
      state.marketplaceError = String(e);
    } finally {
      state.marketplaceLoading = false;
      marketplaceInflight = null;
      emit();
    }
  })();
  return marketplaceInflight;
}

export async function refreshUpdates(): Promise<void> {
  try {
    state.updates = await api.modesCheckUpdates();
    state.updatesLoadedAt = Date.now();
    emit();
  } catch {
    // Offline → leave the previous value alone.
  }
}

export function setActiveMode(slug: string | null) {
  state.activeSlug = slug;
  saveActiveSlug(slug);
  emit();
}

export function useModes(): StoreShape {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── derived selectors ────────────────────────────────────────────────

/** Active mode descriptor, or `null` if no mode is selected. */
export function selectActiveMode(s: StoreShape): ModeDescriptor | null {
  if (!s.activeSlug) return null;
  return s.installed.find((m) => m.id === s.activeSlug) ?? null;
}

/** Marketplace entries that are NOT yet installed locally. The card
 *  list uses this to render "Install" vs "Installed" affordances. */
export function selectMarketplaceUnowned(s: StoreShape) {
  if (!s.marketplace) return [];
  const have = new Set(s.installed.map((m) => m.id));
  return s.marketplace.entries.filter((e) => !have.has(e.id));
}

/** True when the slug has an update available in the marketplace. */
export function hasUpdate(s: StoreShape, slug: string): boolean {
  return s.updates.some((u) => u.slug === slug);
}
