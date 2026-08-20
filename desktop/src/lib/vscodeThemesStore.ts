// Imported VS Code themes — persistence + Monaco registration + reactive hooks.
//
// Themes the user imports (via Settings → Editor Themes) are converted once by
// `vscodeTheme.ts` and the RESULT is cached in localStorage, so we never re-parse
// on every editor mount. One theme can be "active": the file editor renders with
// it, and — opt-in — the whole app chrome reskins from its derived CSS variables.
//
// This module owns three keys:
//   aura.editor.themes      — the imported library (array of StoredVsTheme)
//   aura.editor.activeTheme — id of the active theme, or "" for Aura default
//   aura.editor.applyChrome — "1" to also reskin app chrome from the active theme
//
// The store mirrors `themeStore.ts`'s tiny pub/sub shape so hooks stay in sync
// across every surface without a heavier state library.

import { useEffect, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import { auraThemeName } from "./monacoTheme";
import { isReadablePair } from "./colorContrast";
import {
  CHROME_VAR_KEYS,
  convertVsCodeTheme,
  importVsCodeThemeText,
  type ConvertedTheme,
} from "./vscodeTheme";

export type StoredVsTheme = ConvertedTheme & {
  /** Stable slug used as the Monaco theme name (`vscode:<id>`) + list key. */
  id: string;
  /** Epoch ms; passed in from the caller (the importer) so this module stays
   *  free of ambient clock reads. */
  importedAt: number;
};

const THEMES_KEY = "aura.editor.themes";
const ACTIVE_KEY = "aura.editor.activeTheme";
const CHROME_KEY = "aura.editor.applyChrome";

const subs = new Set<() => void>();
function notify() {
  subs.forEach((fn) => fn());
}

// ── Raw reads/writes ─────────────────────────────────────────────────────

function readThemes(): StoredVsTheme[] {
  try {
    const raw = localStorage.getItem(THEMES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredVsTheme[]) : [];
  } catch {
    return [];
  }
}

function writeThemes(themes: StoredVsTheme[]) {
  try {
    localStorage.setItem(THEMES_KEY, JSON.stringify(themes));
  } catch {
    /* quota / private mode — best-effort */
  }
}

function readActiveId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

function readApplyChrome(): boolean {
  // Default ON: importing a VS Code theme is meant to retone the whole desktop,
  // not just the editor — so an active theme reskins the app unless the user has
  // explicitly opted out (stored "0"). The `chromeIsReadable` guard still
  // refuses any theme whose derived chrome would be unreadable.
  try {
    return localStorage.getItem(CHROME_KEY) !== "0";
  } catch {
    return true;
  }
}

// ── Slug ─────────────────────────────────────────────────────────────────

function slugify(name: string, existing: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "theme";
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── Mutations ────────────────────────────────────────────────────────────

/** Import raw VS Code theme JSON(C), store the converted result, and return it.
 *  Throws a friendly Error if the text isn't a usable color theme. `now` is the
 *  caller-supplied timestamp (keeps this module clock-free / testable). */
export function importThemeFromText(text: string, now: number): StoredVsTheme {
  const converted = importVsCodeThemeText(text);
  return storeConverted(converted, now);
}

/** Store an already-converted theme (used by import + by tests). */
export function storeConverted(
  converted: ConvertedTheme,
  now: number,
): StoredVsTheme {
  const themes = readThemes();
  const id = slugify(converted.name, new Set(themes.map((t) => t.id)));
  const stored: StoredVsTheme = { ...converted, id, importedAt: now };
  writeThemes([...themes, stored]);
  notify();
  return stored;
}

/** Apply a built-in preset (already a `ConvertedTheme`): store it once, then
 *  activate it. Idempotent by display name — re-applying a preset reuses the
 *  existing library row instead of piling up `dracula`, `dracula-2`, … so the
 *  preset cards behave like a radio group, not an import button. Returns the
 *  stored row that is now active. */
export function applyPresetTheme(
  converted: ConvertedTheme,
  now: number,
): StoredVsTheme {
  const existing = readThemes().find((t) => t.name === converted.name);
  if (existing) {
    setActiveTheme(existing.id);
    return existing;
  }
  const stored = storeConverted(converted, now);
  setActiveTheme(stored.id);
  return stored;
}

export function removeTheme(id: string) {
  const themes = readThemes().filter((t) => t.id !== id);
  writeThemes(themes);
  if (readActiveId() === id) setActiveTheme(null);
  else notify();
}

export function setActiveTheme(id: string | null) {
  try {
    localStorage.setItem(ACTIVE_KEY, id ?? "");
  } catch {
    /* best-effort */
  }
  notify();
}

export function setApplyChrome(on: boolean) {
  try {
    localStorage.setItem(CHROME_KEY, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
  notify();
}

// ── Selectors ────────────────────────────────────────────────────────────

export function getThemes(): StoredVsTheme[] {
  return readThemes();
}

export function getActiveTheme(): StoredVsTheme | null {
  const id = readActiveId();
  if (!id) return null;
  return readThemes().find((t) => t.id === id) ?? null;
}

// ── Hooks ────────────────────────────────────────────────────────────────

function useStoreValue<T>(read: () => T): T {
  const [val, setVal] = useState<T>(read);
  useEffect(() => {
    const fn = () => setVal(read());
    subs.add(fn);
    // Cross-tab / cross-window: another window writing the same keys.
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === THEMES_KEY ||
        e.key === ACTIVE_KEY ||
        e.key === CHROME_KEY
      ) {
        fn();
      }
    };
    window.addEventListener("storage", onStorage);
    fn();
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
    // read identity is stable per call-site; intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return val;
}

export function useVsCodeThemes(): StoredVsTheme[] {
  return useStoreValue(readThemes);
}

export function useActiveVsCodeTheme(): StoredVsTheme | null {
  return useStoreValue(getActiveTheme);
}

export function useApplyChrome(): boolean {
  return useStoreValue(readApplyChrome);
}

// ── Monaco registration ──────────────────────────────────────────────────

/** Monaco theme name for an imported theme.
 *
 *  Monaco validates theme names against `/^[a-z0-9\-]+$/i` and throws
 *  "Illegal theme name!" on anything else — so the separator MUST be a hyphen,
 *  not a colon (a `vscode:dracula` name crashed the editor the instant any
 *  imported/preset theme was applied). `id` is already a `[a-z0-9-]` slug
 *  (see `slugify`), so `vscode-<id>` is always legal. */
export function vsThemeName(id: string): string {
  return `vscode-${id}`;
}

/** (Re)define an imported theme in a Monaco instance. Idempotent. */
export function registerEditorTheme(monaco: Monaco, theme: StoredVsTheme): void {
  monaco.editor.defineTheme(vsThemeName(theme.id), theme.monaco);
}

/** Resolve the Monaco theme name the file editor should use: the active
 *  imported theme if one is set, else Aura's GitHub-matched default. The caller
 *  must have registered the active theme first (see `registerEditorTheme`). */
export function editorThemeName(
  isDark: boolean,
  active: StoredVsTheme | null,
): string {
  return active ? vsThemeName(active.id) : auraThemeName(isDark);
}

// ── App-chrome reskin (opt-in) ─────────────────────────────────────────────
//
// When an imported theme is active AND "apply to app" is on, push its derived
// CSS variables onto the document root as INLINE styles — inline wins over the
// stylesheet's variant tokens, so the whole shell adopts the theme's palette.
// Removing the properties restores the normal token cascade exactly. The set of
// vars is `CHROME_VAR_KEYS`, owned by `vscodeTheme.ts` so apply/remove always
// match exactly what `buildCssVars` emits — the full surface + text + brand/
// semantic + widget vocabulary, so a theme retones the whole desktop.

/** Would this theme's derived chrome palette black the app out? We only reskin
 *  when the body text stays legible on the background — a theme whose derived
 *  text would vanish into its own canvas is refused (the editor still themes;
 *  the chrome keeps Aura's readable tokens). Defensive about older cached rows
 *  that predate `cssVars`. */
export function chromeIsReadable(theme: StoredVsTheme | null): boolean {
  const vars = theme?.cssVars;
  if (!vars) return false;
  const bg = vars["--color-bg-0"];
  const fg = vars["--color-text-1"];
  if (!bg || !fg) return false;
  return isReadablePair(bg, fg);
}

function applyChromeVars(theme: StoredVsTheme | null, on: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Apply only when asked AND the result would be readable — never let a picked
  // theme leave the user staring at a blank black screen. A refused theme falls
  // through to the `else` and restores Aura's own token cascade.
  if (on && theme && chromeIsReadable(theme)) {
    const vars = theme.cssVars ?? {};
    for (const v of CHROME_VAR_KEYS) {
      const val = vars[v];
      if (val) root.style.setProperty(v, val);
    }
  } else {
    if (on && theme && !chromeIsReadable(theme)) {
      // Surface why nothing reskinned, instead of silently doing nothing.
      console.warn(
        `[theme] "${theme.name}" was not applied to the app chrome. Its background and text are too low-contrast to stay readable. The editor still uses it.`,
      );
    }
    for (const v of CHROME_VAR_KEYS) root.style.removeProperty(v);
  }
}

/** Mount once at the app root: keeps the chrome CSS variables in lockstep with
 *  the active theme + the apply-chrome toggle, and clears them on unmount. */
export function useApplyVsCodeChrome(): void {
  const active = useActiveVsCodeTheme();
  const on = useApplyChrome();
  useEffect(() => {
    applyChromeVars(active, on);
    return () => applyChromeVars(null, false);
  }, [active, on]);
}

/** Test/inspection seam: the converter the importer runs, re-exported so a
 *  caller can preview without touching storage. */
export { convertVsCodeTheme };
