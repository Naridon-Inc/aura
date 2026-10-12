//! Which engine draws a terminal: the native GPU one (`cmd_native_term`) or
//! xterm.js in the page.
//!
//! Native is the **default** on macOS and Linux. `<Terminal>` mounts
//! `<NativeTerminal>`, which paints a wgpu surface over a transparent DOM hole
//! instead of running xterm in the webview — the engine choice users asked for
//! by name, because the in-page one lags under fast output. Windows stays on
//! xterm until the surface is ported. Settings → Terminal → Rendering writes
//! the override here, and it persists in localStorage, so a user who wants the
//! in-page engine back can say so and keep it.
//!
//! The macOS surface hand-rolls an AppKit Y-flip (`surface.rs::map_dom_rect`)
//! because a raw wgpu NSView can't ride Tauri's `add_child` top-left
//! positioning the way the in-app browser hole does. Two bugs in that flip have
//! been fixed: it used to measure against the contentView rather than the
//! WKWebView (floating the surface one title-bar strip too high), and it used
//! to assume AppKit's default bottom-left origin rather than asking the
//! contentView whether it is flipped. The mapping handles both conventions and
//! is unit-tested off-window.
//!
//! Two things are worth knowing before touching this. A pane whose GPU surface
//! or PTY won't start calls `onUnavailable` and `<Terminal>` drops it to xterm,
//! so a machine this engine can't serve still gets a shell rather than a blank
//! hole — that fallback is what makes default-on safe, and it should not be
//! removed. And placement is checked by running the shell with
//! `AURA_TERM_DEBUG=1`: `ns_frame` prints the contentView box, its `isFlipped`,
//! the resolved webview frame and the computed origin, which is the fastest way
//! to tell a mis-mapped surface from a renderer that never started.

import { getCurrentWindow } from "@tauri-apps/api/window";

const KEY = "NATIVE_TERMINAL";

/** Whether native is the *default* engine. On: native everywhere but Windows.
 *  The explicit `NATIVE_TERMINAL` choice (Settings → Terminal → Rendering)
 *  overrides this either way, so turning it off here only changes what a user
 *  who has never chosen gets.
 *
 *  On. It was held off for one release of this branch while two faults found
 *  against a live session were fixed: a pane took the keyboard when it opened,
 *  so a sentence typed at an agent went to a shell that happened to open
 *  underneath it; and a surface whose hole had been hidden went on painting
 *  where it last was, which is what put a live terminal over the bottom dock's
 *  own chrome and read as a misplaced pane. Both were host bugs rather than
 *  renderer ones — see `nativeSurfacePlacement` for the second — and the
 *  engine itself had already drawn a full agent TUI correctly. */
const NATIVE_DEFAULT_READY = true;

/** Whether this webview is the app's main window — the only one the native
 *  surface can be attached to. Outside Tauri (unit tests, a plain browser)
 *  there are no windows to tell apart, so the answer is yes and the engine
 *  choice is left to the platform default. */
function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** True on Windows, where the native GPU terminal is not yet supported and the
 *  xterm.js engine must stay the default. Mirrors nativeDialog's UA sniff. */
function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Win/i.test(p) || /Windows/i.test(ua);
}

/** The platform's default when the user hasn't chosen an engine: native GPU on
 *  macOS/Linux, xterm on Windows. */
function nativeDefaultForPlatform(): boolean {
  return NATIVE_DEFAULT_READY && !isWindows();
}

/** True when the native GPU terminal should replace xterm.js. Resolves an
 *  explicit user choice first (`"1"`/`"0"`), then falls back to the platform
 *  default. */
export function isNativeTerminalEnabled(): boolean {
  // A detached window can't have one. The Rust side attaches its child surface
  // to the window labelled "main" (`cmd_native_term::prepare`), so a pane that
  // asked for the GPU engine from a popout would hand main-window coordinates
  // a surface nobody in that window can see — and paint it over whatever the
  // main window has at those coordinates. Popouts get xterm until the surface
  // can follow the window that asked for it.
  if (!isMainWindow()) return false;

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
