// User-facing theme preference (dark | light | system). Persisted under
// `aura.theme`. Other components read the resolved theme via
// `useResolvedTheme()` — that hook listens to the OS color-scheme media
// query when the preference is "system" so toggling System Settings
// flips the editor in real time.
//
// A separate "variant" axis (`aura.theme.variant`) layers a named style
// pack on top of the dark/light scheme — e.g. `modal` swaps the arctic
// blue accent for Modal's bright green and pushes surfaces to near
// black. Variants pin the resolved scheme to dark when they only ship a
// dark palette.

import { useEffect, useState } from "react";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type ThemeVariant =
  | "default"
  | "modal"
  | "ember"
  | "amber"
  | "emerald";

const KEY = "aura.theme";
const VARIANT_KEY = "aura.theme.variant";

// ADE surface redesign master flag. The redesign rides one switch — it
// forces the `ember` style pack on and swaps the consolidated sidebar in;
// chrome relocation, NavRail sections, and status avatars all read the
// same flag so the new shell flips atomically.
//
// As of the unified-version release the redesign is the DEFAULT: the flag
// is ON unless a user has explicitly turned it off (value === "0"). A
// missing/unknown value resolves ON so fresh installs and existing users
// who never touched the opt-in both land on the new surface. The one-time
// migration in settingsStore.loadSettings() flips any persisted "0" left
// over from the opt-in era to "1" so nobody is stranded on the old shell.
const ADE_V2_KEY = "aura.ade.v2";

function adeV2On(): boolean {
  try {
    return localStorage.getItem(ADE_V2_KEY) !== "0";
  } catch {
    return true;
  }
}

// Variants that ship dark-only — selecting one forces the resolved
// scheme back to dark so light/system don't fight the variant palette.
//
// `amber` is deliberately NOT in this set. It is the default variant, so
// listing it here would pin every fresh install to dark and leave light
// mode reachable only by first switching to another style pack — a
// setting the user never asked to lose. It ships a real `.light.theme-amber`
// palette (accent #9a6100, 5.14:1 on white), so light is a supported ground.
const DARK_ONLY_VARIANTS: ReadonlySet<ThemeVariant> = new Set<ThemeVariant>([
  "modal",
  "ember",
  "emerald",
]);

const subs = new Set<() => void>();

function notify() {
  subs.forEach((fn) => fn());
}

// External durable stores (settingsStore → ~/.aura/settings.toml) register
// here to mirror every theme/variant/ade_v2 change to disk. themeStore
// stays the live-application authority (it owns the localStorage boot
// cache the pre-hydration script reads); the hook just keeps the TOML in
// lockstep without themeStore needing to import the settings layer.
const persistHooks = new Set<() => void>();

/** Register a callback fired after every theme/variant/ade_v2 set. Returns
 *  an unsubscribe fn. */
export function onThemePersist(fn: () => void): () => void {
  persistHooks.add(fn);
  return () => {
    persistHooks.delete(fn);
  };
}

function persist() {
  persistHooks.forEach((fn) => fn());
}

function readPref(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "light" || raw === "system") return raw;
    return "dark";
  } catch {
    return "dark";
  }
}

function readVariant(): ThemeVariant {
  try {
    // An explicit variant pick (from the theme picker) always wins — that's
    // how a user opts into modal/emerald over the amber default.
    const raw = localStorage.getItem(VARIANT_KEY);
    // `conductor` was this pack's name before it became `amber`. Anyone who
    // picked it back then still has that string on disk, so read it forward
    // rather than silently dropping them onto the default.
    if (raw === "conductor") return "amber";
    if (
      raw === "modal" ||
      raw === "ember" ||
      raw === "amber" ||
      raw === "emerald"
    )
      return raw;
    // No explicit choice: the ADE v2 master flag defaults the surface to the
    // ember pack, so flipping that one key swaps the whole redesign on/off.
    if (adeV2On()) return "amber";
    return "default";
  } catch {
    return adeV2On() ? "amber" : "default";
  }
}

export function setThemePreference(pref: ThemePreference) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — best-effort */
  }
  notify();
  persist();
}

export function setThemeVariant(variant: ThemeVariant) {
  try {
    localStorage.setItem(VARIANT_KEY, variant);
  } catch {
    /* private mode — best-effort */
  }
  notify();
  persist();
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function useThemePreference(): ThemePreference {
  const [pref, setPref] = useState<ThemePreference>(() => readPref());
  useEffect(() => {
    const fn = () => setPref(readPref());
    subs.add(fn);
    // `subs` only fans out within this JS heap. A separate window (the floating
    // HUD, a popout) lives in its own heap, so mirror cross-heap changes via the
    // `storage` event the browser fires when another window writes `aura.theme`.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return pref;
}

export function useThemeVariant(): ThemeVariant {
  const [variant, setVariant] = useState<ThemeVariant>(() => readVariant());
  useEffect(() => {
    const fn = () => setVariant(readVariant());
    subs.add(fn);
    // Cross-heap mirror (see useThemePreference). The variant also derives from
    // the ADE v2 master flag, so a change to either key must re-read.
    const onStorage = (e: StorageEvent) => {
      if (e.key === VARIANT_KEY || e.key === ADE_V2_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return variant;
}

// ADE surface redesign master flag. Reactive twin of adeV2On() above so
// the composition root (App.tsx) can swap the consolidated single-panel
// sidebar in/out without a reload. Setting it also forces the ember
// variant on via readVariant(), so flipping this one key reskins +
// restructures the shell together. (A full reload is still cleanest —
// the pre-hydration script in index.html only reads the flag at boot —
// but the hook keeps React in sync if it changes mid-session.)
export function setAdeV2(on: boolean) {
  try {
    localStorage.setItem(ADE_V2_KEY, on ? "1" : "0");
  } catch {
    /* private mode — best-effort */
  }
  notify();
  persist();
}

export function useAdeV2(): boolean {
  const [on, setOn] = useState<boolean>(() => adeV2On());
  useEffect(() => {
    const fn = () => setOn(adeV2On());
    subs.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === ADE_V2_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return on;
}

export function useResolvedTheme(): ResolvedTheme {
  const pref = useThemePreference();
  const variant = useThemeVariant();
  const [sys, setSys] = useState<ResolvedTheme>(() => systemTheme());
  useEffect(() => {
    if (pref !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => setSys(mql.matches ? "light" : "dark");
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [pref]);
  if (DARK_ONLY_VARIANTS.has(variant)) return "dark";
  return pref === "system" ? sys : pref;
}

// Mirror the resolved theme + variant to classes on <html>. The
// `.light` scope in styles.css overrides the dark-default tokens; named
// variants like `.theme-modal` layer on top and override the accent
// palette. Mounted once at the app root so every change reaches every
// component, including CSS-only primitives (shadcn Dialog/Popover/etc.)
// that don't take a theme prop. The matching pre-hydration script in
// index.html applies the same classes before React mounts so there's
// no flash.
export function useApplyThemeClass(): void {
  const resolved = useResolvedTheme();
  const variant = useThemeVariant();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(resolved);
    root.classList.remove(
      "theme-default",
      "theme-modal",
      "theme-ember",
      "theme-amber",
      "theme-emerald",
    );
    root.classList.add(`theme-${variant}`);
  }, [resolved, variant]);
}
