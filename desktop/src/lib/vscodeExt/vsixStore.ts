// Installed VS Code extensions — frontend cache + reactive hooks.
//
// The Rust install index (`~/.aura/vscode-extensions/index.json`) is the source
// of truth; this module caches it so the editor's contributes router and the
// Extensions surface don't each re-hit IPC on every mount. It mirrors the tiny
// pub/sub shape `vscodeThemesStore.ts` uses so hooks stay in sync everywhere
// without a heavier state library.
//
// It also owns the registry of themes that installed extensions contribute:
// `applyContributes.ts` defines each with Monaco and registers it here, and the
// Extensions / theme-picker surfaces read the list back.

import { useEffect, useState } from "react";

import { api } from "../api";
import type { ExtensionTheme, InstalledExtension } from "./vsixTypes";

const subs = new Set<() => void>();
function notify() {
  subs.forEach((fn) => fn());
}

// ── Installed extensions cache ───────────────────────────────────────────────

let installed: InstalledExtension[] = [];
let loaded = false;
let inFlight: Promise<InstalledExtension[]> | null = null;

export function getInstalled(): InstalledExtension[] {
  return installed;
}

export function getEnabledExtensions(): InstalledExtension[] {
  return installed.filter((e) => e.enabled);
}

/** Subscribe (outside React) to any change in the installed/enabled set. Used by
 *  the web-extension host to reconcile its worker on install / remove / toggle. */
export function subscribeInstalled(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Fetch the install index once and cache it. Concurrent callers share the same
 *  in-flight request. Cheap to call from any editor mount after the first. */
export async function ensureInstalledLoaded(): Promise<InstalledExtension[]> {
  if (loaded) return installed;
  if (inFlight) return inFlight;
  inFlight = api
    .vsixList()
    .then((list) => {
      installed = list;
      loaded = true;
      notify();
      return list;
    })
    .catch(() => {
      // Treat a failed read as "none installed" rather than throwing into every
      // editor mount; the next explicit refresh can recover.
      loaded = true;
      return installed;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Force a re-read of the install index (after install / remove / toggle). */
export async function refreshInstalled(): Promise<InstalledExtension[]> {
  loaded = false;
  inFlight = null;
  return ensureInstalledLoaded();
}

// ── Mutations (thin wrappers that keep the cache fresh) ──────────────────────

export async function installExtension(
  namespace: string,
  name: string,
  version?: string,
): Promise<InstalledExtension> {
  const ext = await api.vsixInstall(namespace, name, version);
  await refreshInstalled();
  return ext;
}

export async function installExtensionFile(
  path: string,
): Promise<InstalledExtension> {
  const ext = await api.vsixInstallFile(path);
  await refreshInstalled();
  return ext;
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await api.vsixSetEnabled(id, enabled);
  await refreshInstalled();
}

export async function removeExtension(id: string): Promise<void> {
  await api.vsixRemove(id);
  await refreshInstalled();
}

// ── Extension-contributed theme registry ─────────────────────────────────────
//
// Keyed by Monaco theme name so re-applying the same extension overwrites rather
// than piling up. The router clears it whenever the enabled set changes and
// refills, so the list always reflects exactly what's currently enabled.

const extThemes = new Map<string, ExtensionTheme>();

export function clearExtensionThemes(): void {
  if (extThemes.size === 0) return;
  extThemes.clear();
  notify();
}

export function registerExtensionTheme(theme: ExtensionTheme): void {
  extThemes.set(theme.themeName, theme);
  notify();
}

export function getExtensionThemes(): ExtensionTheme[] {
  return [...extThemes.values()];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function useStoreValue<T>(read: () => T): T {
  const [val, setVal] = useState<T>(read);
  useEffect(() => {
    const fn = () => setVal(read());
    subs.add(fn);
    fn();
    return () => {
      subs.delete(fn);
    };
    // read identity is stable per call-site; intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return val;
}

/** Installed extensions, loading the index on first use. */
export function useInstalledExtensions(): InstalledExtension[] {
  useEffect(() => {
    void ensureInstalledLoaded();
  }, []);
  return useStoreValue(getInstalled);
}

/** Themes contributed by the currently enabled extensions. */
export function useExtensionThemes(): ExtensionTheme[] {
  return useStoreValue(getExtensionThemes);
}
