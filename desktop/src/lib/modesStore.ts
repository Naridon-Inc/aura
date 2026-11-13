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
  /** Why the last update check didn't finish. Kept because the dialog used to
   *  read an empty `updates` as "All modes are up to date", which is the one
   *  sentence a failed check must never produce. */
  updatesError: string | null;
  updatesLoading: boolean;
};

let state: StoreShape = {
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
  updatesError: null,
  updatesLoading: false,
};

const listeners = new Set<() => void>();

// useSyncExternalStore compares snapshots by identity, so every change hands
// it a new object. Mutating `state` in place and returning the same object
// meant React never redrew: the list stayed empty after modes loaded.
function emit() {
  state = { ...state };
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
  state.updatesLoading = true;
  emit();
  try {
    state.updates = await api.modesCheckUpdates();
    state.updatesLoadedAt = Date.now();
    state.updatesError = null;
  } catch (e) {
    // Offline → keep whatever rows we already had; they're the last thing we
    // actually knew. But RECORD the failure: an empty `updates` used to read
    // as "All modes are up to date", so a check that never completed
    // announced the all-clear. `updatesLoadedAt` deliberately stays put.
    state.updatesError = String(e);
  } finally {
    state.updatesLoading = false;
    emit();
  }
}

export function useModes(): StoreShape {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── derived selectors ────────────────────────────────────────────────

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
