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

/** How hard the dark ground and its type are pushed apart. `low` is for
 *  people who find the full-contrast dark theme harsh over a long day — the
 *  same palette, softened, with the accent left exactly where it was. */
export type ThemeContrast = "normal" | "low";

const KEY = "aura.theme";
const VARIANT_KEY = "aura.theme.variant";
const CONTRAST_KEY = "aura.theme.contrast";

// ── Low contrast ─────────────────────────────────────────────────────────
//
// Not a fourth style pack: a softening applied over whichever dark pack is
// on. The type steps a little toward the ground and the ground lifts a
// little toward the type, so the ratio between them drops by about 15% —
// enough to take the edge off, not enough to fall under the AA floor body
// copy sits on. The accent, the semantic colours (green / amber / red) and
// the primary button are left alone: those carry meaning, and a warning
// that read as calmer would be a warning that lied.

/** The dark tokens the softening touches. Every one is a flat hex in each
 *  pack; the aliases that point at them (`--color-bg-card` and friends)
 *  follow on their own. */
export const SOFTENED_TOKENS: readonly string[] = [
  "--color-bg-0",
  "--color-bg-1",
  "--color-bg-2",
  "--color-bg-3",
  "--color-bg-layer-3",
  "--color-composer-bg",
  "--color-composer-border",
  "--color-popover-bg",
  "--color-popover-border",
  "--color-popover-row-hover",
  "--color-pill-bg",
  "--color-pill-bg-hover",
  "--color-kbd-bg",
  "--color-avatar-bg",
  "--color-line",
  "--color-line-soft",
  "--color-text-1",
  "--color-text-2",
  "--color-text-3",
  "--color-text-4",
  "--color-text-5",
  "--color-pill-fg",
  "--color-kbd-fg",
  "--color-avatar-fg",
];

/** The Amber pack's dark tokens — the ground almost everyone is on, and the
 *  fixture the softening is judged against in tests. Kept in step with
 *  `.theme-amber` in styles.css by hand; the runtime reads the live values
 *  off the document instead, so a pack edit does not have to come here. */
export const AMBER_DARK_TOKENS: Readonly<Record<string, string>> = {
  "--color-bg-0": "#1c1815",
  "--color-bg-1": "#15120f",
  "--color-bg-2": "#272220",
  "--color-bg-3": "#2d2724",
  "--color-bg-layer-3": "#342d28",
  "--color-composer-bg": "#1f1b18",
  "--color-composer-border": "#2d2825",
  "--color-popover-bg": "#1f1b18",
  "--color-popover-border": "#2d2825",
  "--color-popover-row-hover": "#272220",
  "--color-pill-bg": "#2d2724",
  "--color-pill-bg-hover": "#353029",
  "--color-kbd-bg": "#2d2724",
  "--color-avatar-bg": "#2a2520",
  "--color-line": "#302b26",
  "--color-line-soft": "#282320",
  "--color-text-1": "#f0ece7",
  "--color-text-2": "#bab5ad",
  "--color-text-3": "#898279",
  "--color-text-4": "#5a554d",
  "--color-text-5": "#3b3732",
  "--color-pill-fg": "#c8c3bb",
  "--color-kbd-fg": "#c8c3bb",
  "--color-avatar-fg": "#bdb5aa",
  "--color-accent": "#6aa885",
};

/** How much the low setting softens: the drop in the text-on-ground contrast
 *  ratio it aims for. */
export const LOW_CONTRAST_AMOUNT = 0.15;

type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
  const v = value.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex([r, g, b]: Rgb): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** `a` moved `t` of the way toward `b`, in sRGB. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** WCAG relative luminance of a hex colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two hex colours, always >= 1. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The same dark palette with its contrast taken down by `amount`.
 *
 *  Type tokens step toward the content ground (`--color-bg-0`) and ground
 *  tokens lift toward the type (`--color-text-1`). The ground moves less than
 *  the type does: a dark surface's luminance sits so near zero that a small
 *  lift is a large share of it, so the two mixes are weighted to land the
 *  ratio drop on `amount` rather than overshoot it. Any token that is not a
 *  flat hex is passed through untouched — a value like `var(--color-bg-1)`
 *  follows whatever it points at. The accent is never in the result. */
export function softenDarkPalette(
  tokens: Readonly<Record<string, string>>,
  amount = LOW_CONTRAST_AMOUNT,
): Record<string, string> {
  const ground = parseHex(tokens["--color-bg-0"] ?? "");
  const ink = parseHex(tokens["--color-text-1"] ?? "");
  if (!ground || !ink) return {};
  const textMix = amount * 0.42;
  const groundMix = amount * 0.13;
  const out: Record<string, string> = {};
  for (const name of SOFTENED_TOKENS) {
    const raw = tokens[name];
    if (raw === undefined) continue;
    const rgb = parseHex(raw);
    if (!rgb) continue;
    const isInk =
      name.startsWith("--color-text-") ||
      name === "--color-pill-fg" ||
      name === "--color-kbd-fg" ||
      name === "--color-avatar-fg";
    out[name] = isInk ? toHex(mix(rgb, ground, textMix)) : toHex(mix(rgb, ink, groundMix));
  }
  return out;
}

/** The Amber dark pack, softened — what the low setting paints on a fresh
 *  install. */
export const LOW_CONTRAST_AMBER_DARK: Readonly<Record<string, string>> =
  softenDarkPalette(AMBER_DARK_TOKENS);

function readContrast(): ThemeContrast {
  try {
    return localStorage.getItem(CONTRAST_KEY) === "low" ? "low" : "normal";
  } catch {
    return "normal";
  }
}

export function setThemeContrast(contrast: ThemeContrast) {
  try {
    localStorage.setItem(CONTRAST_KEY, contrast);
  } catch {
    /* private mode — best-effort */
  }
  notify();
  persist();
}

export function useThemeContrast(): ThemeContrast {
  const [contrast, setContrast] = useState<ThemeContrast>(() => readContrast());
  useEffect(() => {
    const fn = () => setContrast(readContrast());
    subs.add(fn);
    // Cross-heap mirror — see useThemePreference.
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONTRAST_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return contrast;
}

/** Paint or clear the softened palette on `<html>`.
 *
 *  Reads the pack's live values off the document — after clearing any earlier
 *  softening, so a second application does not soften the softened — and
 *  writes the result inline, which outranks the pack's class rules without
 *  a stylesheet having to know each pack. */
function applyContrast(root: HTMLElement, low: boolean): void {
  for (const name of SOFTENED_TOKENS) root.style.removeProperty(name);
  root.classList.toggle("contrast-low", low);
  if (!low) return;
  const live = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of SOFTENED_TOKENS) tokens[name] = live.getPropertyValue(name);
  const soft = softenDarkPalette(tokens);
  for (const [name, value] of Object.entries(soft)) root.style.setProperty(name, value);
}

// Variants that ship dark-only — selecting one forces the resolved
// scheme back to dark so light/system don't fight the variant palette.
//
// `amber` is deliberately NOT in this set. It is the default variant, so
// listing it here would pin every fresh install to dark and leave light
// mode reachable only by first switching to another style pack — a
// setting the user never asked to lose. It ships a real `.light.theme-amber`
// palette (accent #9a6100, 5.14:1 on white), so light is a supported ground.
export function isDarkOnlyVariant(v: ThemeVariant): boolean {
  return DARK_ONLY_VARIANTS.has(v);
}

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
// here to mirror every theme/variant change to disk. themeStore
// stays the live-application authority (it owns the localStorage boot
// cache the pre-hydration script reads); the hook just keeps the TOML in
// lockstep without themeStore needing to import the settings layer.
const persistHooks = new Set<() => void>();

/** Register a callback fired after every theme/variant set. Returns
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
    // No explicit choice: `amber` is the app's ground. It used to fall back
    // to a "default" pack, which was the pre-redesign palette — there is one
    // shell now, so there is no second palette to land on.
    return "amber";
  } catch {
    return "amber";
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
    // Cross-heap mirror — see useThemePreference.
    const onStorage = (e: StorageEvent) => {
      if (e.key === VARIANT_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return variant;
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
  const contrast = useThemeContrast();
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
    // Low contrast is a dark-only softening: the light packs are already
    // paper-and-ink and have nothing to take the edge off. Applied after the
    // classes so it reads the pack that is now on.
    applyContrast(root, resolved === "dark" && contrast === "low");
  }, [resolved, variant, contrast]);
}
