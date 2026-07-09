// Sidebar glass (macOS vibrancy) preference.
//
// On macOS the main window is created transparent with a native
// NSVisualEffectView behind it (hud.rs::apply_main_window_vibrancy); the
// `vibrancy` class on <html> is what tells styles.css to punch the ADE shell
// wrappers translucent so the desktop blurs through the sidebar. This module
// gates that class behind a user preference so anyone who prefers a solid
// background can turn the frost off.
//
// Stored in its OWN localStorage key rather than settings.toml: the class must
// be decided synchronously at boot (main.tsx, before React) to avoid a flash of
// the wrong surface — exactly like the theme boot cache — and vibrancy is a
// pure client/DOM concern that never round-trips through the Rust settings
// document.

const LS_KEY = "aura.appearance.sidebarGlass";

/** True unless the user explicitly turned the glass off. Defaults on so macOS
 *  keeps its frosted sidebar out of the box (byte-for-byte the prior look). */
export function sidebarGlassEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Glass only exists on macOS (the NSVisualEffectView backing). Elsewhere the
 *  toggle would have nothing to blur, so callers hide it and the `vibrancy`
 *  class is never added. */
export function sidebarGlassAvailable(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
}

/** Persist the choice and apply it live: add/remove the `vibrancy` class so the
 *  sidebar switches between frosted glass and a solid background without a
 *  reload. The visual half is a no-op off macOS (no frost to toggle), but the
 *  preference is still stored. Only the main window ever renders Settings, so
 *  this never touches a HUD/popout document. */
export function setSidebarGlass(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, on ? "true" : "false");
  } catch {
    /* private mode — best-effort; the live class change below still applies */
  }
  if (!sidebarGlassAvailable()) return;
  const root = document.documentElement;
  if (on) root.classList.add("vibrancy");
  else root.classList.remove("vibrancy");
}
