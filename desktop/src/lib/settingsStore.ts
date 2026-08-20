// Durable user preferences. The single source of truth is
// `~/.aura/settings.toml` (cmd_settings_prefs.rs); this module is the
// frontend mirror that loads it once, keeps an in-memory copy, applies
// changes live, and writes the whole document back on every change.
//
// localStorage is kept as a write-through BOOT CACHE: the pre-hydration
// script in index.html and themeStore read localStorage synchronously
// before React (and before the async TOML load) so the app paints with
// the right theme on the very first frame. settings.toml is the durable
// truth; localStorage is the fast cache we reconcile to it on load.
//
// Migration: the first run after upgrade has no settings.toml, so
// `settingsPrefsLoad()` returns null. We then seed the TOML from whatever
// the legacy localStorage keys hold (or app defaults), so nobody loses a
// setting they'd already chosen.

import { useEffect, useState } from "react";
import { api, type AppSettings } from "./api";
import { emitHudSettings, type HudPresentationMode } from "./hud";
import {
  onThemePersist,
  setThemePreference,
  setThemeVariant,
  type ThemePreference,
  type ThemeVariant,
} from "./themeStore";

// localStorage keys. The theme three are SHARED with themeStore (it reads
// them at boot and the index.html pre-hydration script reads `aura.theme`
// / `aura.theme.variant`); the rest are the legacy
// SettingsDialog keys we migrate from and keep mirrored as the boot cache.
const LS = {
  theme: "aura.theme",
  variant: "aura.theme.variant",
  fontSize: "aura.editor.fontSize",
  vim: "aura.editor.vim",
  minimap: "aura.editor.minimap",
  sticky: "aura.editor.stickyScroll",
  indent: "aura.editor.indentGuides",
  bell: "aura.terminal.bell",
  cursorBlink: "aura.terminal.cursorBlink",
  scrollback: "aura.terminal.scrollback",
  terminalFontSize: "aura.terminal.fontSize",
  intentInspector: "aura.flags.intentInspector",
  provenanceReplay: "aura.flags.provenanceReplay",
  managerWorktrees: "aura.flags.managerWorktrees",
  showTokenSavings: "aura.flags.showTokenSavings",
  showMessageTokens: "aura.flags.showMessageTokens",
  // The HUD reads these synchronously at mount (shared origin), so they MUST
  // stay mirrored as the boot cache, not just in the TOML.
  hudEnabled: "aura.hud.enabled",
  hudMode: "aura.hud.mode",
  hudOpacity: "aura.hud.opacity",
  hudSidebarWidth: "aura.hud.sidebarWidth",
  hudSidebarHeight: "aura.hud.sidebarHeight",
  hudPet: "aura.hud.pet",
  // Read synchronously by `resolveWorkspaceLanding` on the launch path, which
  // runs off a window event and cannot await the TOML load, so this one has to
  // stay mirrored as the boot cache rather than living only in the document.
  workspaceOpenIn: "aura.workspace.openIn",
} as const;

// App defaults — mirror the Rust `Default` impls in cmd_settings_prefs.rs.
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: "dark", variant: "amber", font_size: 13 },
  editor: { vim: false, minimap: true, sticky_scroll: true, indent_guides: true },
  terminal: { bell: false, cursor_blink: true, scrollback: 5000, font_size: null },
  flags: {
    intent_inspector: false,
    provenance_replay: false,
    manager_worktrees: false,
    show_token_savings: true,
    show_message_tokens: false,
  },
  hud: {
    enabled: true,
    mode: "capsule",
    opacity: 1,
    sidebar_width: 320,
    sidebar_height: 520,
    pet: true,
  },
  // A new copy opens into the code and nothing else. The app used to always
  // start an Aura chat here; that is one good answer out of several, so it
  // became a choice with the quietest option as its default.
  workspace: { open_in: "code" },
};

const HUD_MODES: readonly HudPresentationMode[] = [
  "capsule",
  "sidebar",
  "minimal",
  "ambient",
];

/** Coerce a raw localStorage/TOML mode to a valid one (defaults to capsule). */
function hudMode(raw: string | null | undefined): HudPresentationMode {
  return HUD_MODES.includes(raw as HudPresentationMode)
    ? (raw as HudPresentationMode)
    : "capsule";
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode — best-effort */
  }
}
function lsBool(key: string, fallback: boolean): boolean {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  return raw === "true";
}
function lsNum(key: string, fallback: number): number {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
// A number the user may never have chosen. `null` is a real value here — it
// means "use the platform default" — so an absent key and a junk key both
// have to come back as null rather than as some invented number.
function lsNumOrNull(key: string, fallback: number | null): number | null {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  if (raw === "null" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Build an AppSettings purely from the legacy localStorage keys (the boot
// cache). Used as the synchronous initial in-memory state and as the
// migration seed when no settings.toml exists yet.
function readFromLocalStorage(): AppSettings {
  const d = DEFAULT_SETTINGS;
  const rawTheme = lsGet(LS.theme);
  const theme =
    rawTheme === "light" || rawTheme === "system" || rawTheme === "dark"
      ? rawTheme
      : d.appearance.theme;
  const rawVariant = lsGet(LS.variant);
  // Mirror themeStore.readVariant() exactly: an explicit style pick wins,
  // otherwise the ground. (Forcing the ground over an explicit pick would
  // silently revert modal/emerald on the next TOML load.)
  const variant =
    rawVariant === "modal" ||
    rawVariant === "ember" ||
    rawVariant === "amber" ||
    rawVariant === "emerald"
      ? rawVariant
      : d.appearance.variant;
  return {
    appearance: {
      theme,
      variant,
      font_size: lsNum(LS.fontSize, d.appearance.font_size),
    },
    editor: {
      vim: lsBool(LS.vim, d.editor.vim),
      minimap: lsBool(LS.minimap, d.editor.minimap),
      sticky_scroll: lsBool(LS.sticky, d.editor.sticky_scroll),
      indent_guides: lsBool(LS.indent, d.editor.indent_guides),
    },
    terminal: {
      bell: lsBool(LS.bell, d.terminal.bell),
      cursor_blink: lsBool(LS.cursorBlink, d.terminal.cursor_blink),
      scrollback: lsNum(LS.scrollback, d.terminal.scrollback),
      font_size: lsNumOrNull(LS.terminalFontSize, d.terminal.font_size),
    },
    flags: {
      intent_inspector: lsBool(LS.intentInspector, d.flags.intent_inspector),
      provenance_replay: lsBool(LS.provenanceReplay, d.flags.provenance_replay),
      manager_worktrees: lsBool(LS.managerWorktrees, d.flags.manager_worktrees),
      show_token_savings: lsBool(LS.showTokenSavings, d.flags.show_token_savings),
      show_message_tokens: lsBool(LS.showMessageTokens, d.flags.show_message_tokens),
    },
    hud: {
      enabled: lsBool(LS.hudEnabled, d.hud.enabled),
      mode: hudMode(lsGet(LS.hudMode)),
      opacity: lsNum(LS.hudOpacity, d.hud.opacity),
      sidebar_width: lsNum(LS.hudSidebarWidth, d.hud.sidebar_width),
      sidebar_height: lsNum(LS.hudSidebarHeight, d.hud.sidebar_height),
      pet: lsBool(LS.hudPet, d.hud.pet),
    },
    workspace: {
      open_in: lsGet(LS.workspaceOpenIn) || d.workspace.open_in,
    },
  };
}

// Mirror a settings document to the localStorage boot cache so the next
// cold start (and themeStore) paint with these values before the TOML
// loads. The theme keys feed themeStore + the index.html pre-hydration
// script; the rest keep the cache coherent for migration idempotency.
function mirrorToLocalStorage(s: AppSettings) {
  lsSet(LS.theme, s.appearance.theme);
  lsSet(LS.variant, s.appearance.variant);
  lsSet(LS.fontSize, String(s.appearance.font_size));
  lsSet(LS.vim, String(s.editor.vim));
  lsSet(LS.minimap, String(s.editor.minimap));
  lsSet(LS.sticky, String(s.editor.sticky_scroll));
  lsSet(LS.indent, String(s.editor.indent_guides));
  lsSet(LS.bell, String(s.terminal.bell));
  lsSet(LS.cursorBlink, String(s.terminal.cursor_blink));
  lsSet(LS.scrollback, String(s.terminal.scrollback));
  lsSet(LS.terminalFontSize, String(s.terminal.font_size));
  lsSet(LS.intentInspector, String(s.flags.intent_inspector));
  lsSet(LS.provenanceReplay, String(s.flags.provenance_replay));
  lsSet(LS.managerWorktrees, String(s.flags.manager_worktrees));
  lsSet(LS.showTokenSavings, String(s.flags.show_token_savings));
  lsSet(LS.showMessageTokens, String(s.flags.show_message_tokens));
  lsSet(LS.hudEnabled, String(s.hud.enabled));
  lsSet(LS.hudMode, s.hud.mode);
  lsSet(LS.hudOpacity, String(s.hud.opacity));
  lsSet(LS.hudSidebarWidth, String(s.hud.sidebar_width));
  lsSet(LS.hudSidebarHeight, String(s.hud.sidebar_height));
  lsSet(LS.hudPet, String(s.hud.pet));
  lsSet(LS.workspaceOpenIn, s.workspace.open_in);
}

// Fill any missing nested field from defaults so an older or hand-trimmed
// TOML can't produce an undefined read downstream.
function normalize(s: AppSettings): AppSettings {
  const d = DEFAULT_SETTINGS;
  return {
    appearance: { ...d.appearance, ...(s.appearance ?? {}) },
    editor: { ...d.editor, ...(s.editor ?? {}) },
    terminal: { ...d.terminal, ...(s.terminal ?? {}) },
    flags: { ...d.flags, ...(s.flags ?? {}) },
    hud: { ...d.hud, ...(s.hud ?? {}) },
    workspace: { ...d.workspace, ...(s.workspace ?? {}) },
  };
}

let state: AppSettings = readFromLocalStorage();
let loaded = false;

const subs = new Set<() => void>();
function notify() {
  subs.forEach((fn) => fn());
}

// Debounced write-back. Coalesces a burst of toggles into one disk write.
// localStorage already holds the value synchronously, so a dropped/delayed
// TOML write never costs the user the setting within the session.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void api.settingsPrefsSave(state).catch(() => {
      /* best-effort; the boot cache already has it */
    });
  }, 200);
}

/** Fire any pending debounced write immediately. Without this, a setting
 *  toggled within the 200ms debounce window and then a quick ⌘Q is lost:
 *  localStorage holds it for the session, but the NEXT launch reconciles
 *  the boot cache back to the (stale) TOML in `loadSettings`, so the toggle
 *  silently reverts. Best-effort — the IPC is posted even if its promise
 *  can't settle before the window tears down. */
export function flushSettings(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  void api.settingsPrefsSave(state).catch(() => {});
}

// Flush on teardown so the last toggle before a quit/close survives. Both
// events fire as the webview unloads; the duplicate flush is a no-op once
// the timer is cleared.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushSettings);
  window.addEventListener("pagehide", flushSettings);
}

// Push appearance into the live theme so a TOML edited out-of-band (or
// synced from another device) reskins the running app, not just the next
// boot. Goes through themeStore so its reactive hooks + the <html> class
// mirror update.
function applyThemeFromState() {
  setThemePreference(state.appearance.theme as ThemePreference);
  setThemeVariant(state.appearance.variant as ThemeVariant);
}

// Push the HUD prefs to the native side. `hud_set_mode` stores the Rust mode
// atomic even when the HUD window doesn't exist yet, so the FIRST ⌘⇧A summon
// already places in the chosen shape; opacity re-applies HUD-side on mount.
function applyHudToWindow(s: AppSettings) {
  void api.hudSetEnabled(s.hud.enabled).catch(() => {});
  void api.hudSetMode(s.hud.mode).catch(() => {});
  void api.hudSetOpacity(s.hud.opacity).catch(() => {});
}

// Keep settings.toml in lockstep with any theme change made through
// themeStore — the AppearanceTab style / color-scheme pickers still go
// through it for live application. When it fires, pull the freshly-written
// theme values out of the boot cache and persist the whole document.
onThemePersist(() => {
  const rawTheme = lsGet(LS.theme);
  const rawVariant = lsGet(LS.variant);
  state = {
    ...state,
    appearance: {
      ...state.appearance,
      theme:
        rawTheme === "light" || rawTheme === "system" || rawTheme === "dark"
          ? rawTheme
          : state.appearance.theme,
      variant:
        rawVariant === "modal" ||
        rawVariant === "ember" ||
        rawVariant === "amber" ||
        rawVariant === "emerald"
          ? rawVariant
          : state.appearance.variant,
    },
  };
  notify();
  saveSoon();
});

/** Load the durable TOML and reconcile. Call once at app startup. On first
 *  run (no file) it seeds the TOML from the localStorage boot cache so the
 *  user's prior choices survive; otherwise it adopts the TOML, refreshes
 *  the boot cache, and re-applies the live theme. Idempotent. */
export async function loadSettings(): Promise<AppSettings> {
  if (loaded) return state;
  let fromDisk: AppSettings | null = null;
  try {
    fromDisk = await api.settingsPrefsLoad();
  } catch {
    fromDisk = null;
  }
  loaded = true;
  if (!fromDisk) {
    // Migration / first run: keep whatever the boot cache held, force the
    // ADE v2 default on, and seed the TOML with it so the choice survives
    // the next launch.
    state = readFromLocalStorage();
    mirrorToLocalStorage(state);
    applyThemeFromState();
    applyHudToWindow(state);
    saveSoon();
    notify();
    return state;
  }
  const adopted = normalize(fromDisk);
  state = adopted;
  mirrorToLocalStorage(state);
  applyThemeFromState();
  applyHudToWindow(state);
  notify();
  return state;
}

/** Current in-memory settings. Synchronous; reflects the boot cache until
 *  `loadSettings()` resolves, then the durable TOML. Use for one-shot reads
 *  (e.g. xterm construction); prefer the hooks for reactive UI. */
export function getSettings(): AppSettings {
  return state;
}

// ── Setters (write-through: in-memory + boot cache + debounced TOML) ──────

const EDITOR_LS: Record<keyof AppSettings["editor"], string> = {
  vim: LS.vim,
  minimap: LS.minimap,
  sticky_scroll: LS.sticky,
  indent_guides: LS.indent,
};

const FLAG_LS: Record<keyof AppSettings["flags"], string> = {
  intent_inspector: LS.intentInspector,
  provenance_replay: LS.provenanceReplay,
  manager_worktrees: LS.managerWorktrees,
  show_token_savings: LS.showTokenSavings,
  show_message_tokens: LS.showMessageTokens,
};

/** Monaco font size (px). Lives under `appearance` but the AppearanceTab
 *  font picker is its only writer. */
export function setFontSize(n: number) {
  state = { ...state, appearance: { ...state.appearance, font_size: n } };
  lsSet(LS.fontSize, String(n));
  notify();
  saveSoon();
}

export function setEditorPref<K extends keyof AppSettings["editor"]>(
  key: K,
  val: AppSettings["editor"][K],
) {
  state = { ...state, editor: { ...state.editor, [key]: val } };
  lsSet(EDITOR_LS[key], String(val));
  notify();
  saveSoon();
}

export function setTerminalBool(key: "bell" | "cursor_blink", val: boolean) {
  const lsKey = key === "bell" ? LS.bell : LS.cursorBlink;
  state = { ...state, terminal: { ...state.terminal, [key]: val } };
  lsSet(lsKey, String(val));
  notify();
  saveSoon();
}

export function setScrollback(n: number) {
  state = { ...state, terminal: { ...state.terminal, scrollback: n } };
  lsSet(LS.scrollback, String(n));
  notify();
  saveSoon();
}

/** The type size a terminal uses when the user has never set one. VS Code's
 *  own terminal defaults, which the xterm construction in `Terminal.tsx`
 *  already matched by hand: 12 on macOS, 14 elsewhere. */
export function defaultTerminalFontSize(): number {
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return isMac ? 12 : 14;
}

/** Type size in terminal panes (px). Applies to terminals opened after the
 *  change — the xterm instance reads it once at construction, same as
 *  scrollback and cursor blink. */
export function setTerminalFontSize(n: number) {
  state = { ...state, terminal: { ...state.terminal, font_size: n } };
  lsSet(LS.terminalFontSize, String(n));
  notify();
  saveSoon();
}

export function setFlag(key: keyof AppSettings["flags"], val: boolean) {
  state = { ...state, flags: { ...state.flags, [key]: val } };
  lsSet(FLAG_LS[key], String(val));
  notify();
  saveSoon();
}

const HUD_LS_KEY: Record<keyof AppSettings["hud"], string> = {
  enabled: LS.hudEnabled,
  mode: LS.hudMode,
  opacity: LS.hudOpacity,
  sidebar_width: LS.hudSidebarWidth,
  sidebar_height: LS.hudSidebarHeight,
  pet: LS.hudPet,
};

/** Set a HUD presentation pref (mode / opacity / sidebar dims) and apply it
 *  live. Persists like the other setters, then — for mode/opacity — pushes to
 *  the native HUD window (so a hidden or not-yet-created HUD still picks up the
 *  right shape on its next summon), and always broadcasts `hud:settings` so a
 *  mounted HUD updates its CSS (the sidebar dims become CSS vars there). */
export function setHudPref<K extends keyof AppSettings["hud"]>(
  key: K,
  val: AppSettings["hud"][K],
) {
  state = { ...state, hud: { ...state.hud, [key]: val } };
  lsSet(HUD_LS_KEY[key], String(val));
  notify();
  saveSoon();
  if (key === "mode") void api.hudSetMode(String(val)).catch(() => {});
  else if (key === "opacity") void api.hudSetOpacity(Number(val)).catch(() => {});
  else if (key === "enabled")
    void api.hudSetEnabled(Boolean(val)).catch(() => {});
  void emitHudSettings({
    mode: hudMode(state.hud.mode),
    opacity: state.hud.opacity,
    sidebarWidth: state.hud.sidebar_width,
    sidebarHeight: state.hud.sidebar_height,
    pet: state.hud.pet,
  });
}

/** Choose what a freshly-made copy of a project opens into: `"code"` to open
 *  nothing, `"chat"` for an Aura chat seeded with the objective, or an agent
 *  CLI id to land in that CLI's terminal. Stored as a plain string so an agent
 *  that is later uninstalled degrades on read instead of on write — see
 *  `resolveWorkspaceLanding`. */
export function setWorkspaceOpenIn(value: string) {
  state = { ...state, workspace: { ...state.workspace, open_in: value } };
  lsSet(LS.workspaceOpenIn, value);
  notify();
  saveSoon();
}

// ── Reactive hooks ────────────────────────────────────────────────────────

function useSettings(): AppSettings {
  const [s, setS] = useState<AppSettings>(() => state);
  useEffect(() => {
    const fn = () => setS(state);
    subs.add(fn);
    // Sync once in case state changed between initial render and effect
    // (e.g. loadSettings resolved during mount).
    fn();
    return () => {
      subs.delete(fn);
    };
  }, []);
  return s;
}

export function useEditorPrefs(): AppSettings["editor"] {
  return useSettings().editor;
}

export function useTerminalPrefs(): AppSettings["terminal"] {
  return useSettings().terminal;
}

export function useFlagPrefs(): AppSettings["flags"] {
  return useSettings().flags;
}

export function useHudPrefs(): AppSettings["hud"] {
  return useSettings().hud;
}

export function useWorkspacePrefs(): AppSettings["workspace"] {
  return useSettings().workspace;
}

export function useFontSize(): number {
  return useSettings().appearance.font_size;
}
