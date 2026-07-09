//! Feature flag for the native GPU terminal (cmd_native_term).
//!
//! Currently **opt-in** — xterm.js stays the default engine on every platform.
//! Flipping the flag on (`"1"`) makes `<Terminal>` mount `<NativeTerminal>`,
//! which paints a wgpu surface over a transparent DOM hole instead of running
//! xterm. Persisted in localStorage so a reload keeps the choice.
//!
//! WHY NOT DEFAULT YET: the macOS surface hand-rolls an AppKit Y-flip
//! (`surface.rs::ns_frame`, `contentView.bounds.height - y - h`) because a raw
//! wgpu NSView can't ride Tauri's `add_child` top-left positioning the way the
//! in-app browser hole does. That flip currently lands the surface one
//! hole-height too high (it floats over the pane above instead of filling the
//! hole). Pixel placement can only be verified live (the synthetic-input wall
//! blocks driving the WKWebView), so native stays opt-in until the surface math
//! is confirmed against real pixels — then flip `NATIVE_DEFAULT_READY` to `true`
//! and it becomes the platform default again (Windows excepted). The auto-
//! fallback + session-persistence built for default-on stay in place regardless.

const KEY = "NATIVE_TERMINAL";

/** Gate for making native the *default* engine. Held `false` until the macOS/
 *  Linux surface positioning is verified live (see the file header). When this
 *  flips `true`, native becomes the default everywhere except Windows; the
 *  explicit `NATIVE_TERMINAL` localStorage choice still overrides either way. */
const NATIVE_DEFAULT_READY = false;

/** True on Windows, where the native GPU terminal is not yet supported and the
 *  xterm.js engine must stay the default. Mirrors nativeDialog's UA sniff. */
function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Win/i.test(p) || /Windows/i.test(ua);
}

/** The platform's default when the user hasn't chosen an engine. Native GPU on
 *  macOS/Linux once `NATIVE_DEFAULT_READY`; xterm on Windows and until then. */
function nativeDefaultForPlatform(): boolean {
  return NATIVE_DEFAULT_READY && !isWindows();
}

/** True when the native GPU terminal should replace xterm.js. Resolves an
 *  explicit user choice first (`"1"`/`"0"`), then falls back to the platform
 *  default. `"1"` still force-enables native for live surface testing even
 *  while it's not the default. */
export function isNativeTerminalEnabled(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // storage unavailable (private mode) — fall through to the platform default
    raw = null;
  }
  if (raw === "1") return true;
  if (raw === "0") return false;
  return nativeDefaultForPlatform();
}

/** Turn the native terminal on/off explicitly. Takes effect for terminals
 *  mounted after the change (existing panes keep their current engine until
 *  remounted). Persisted so a reload keeps the choice. */
export function setNativeTerminalEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode / storage disabled — silently keep the platform default */
  }
}
