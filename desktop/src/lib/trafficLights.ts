// Runtime control of the macOS native window controls ("traffic lights").
//
// The window ships with the lights at the top-left (tauri.conf.json →
// `trafficLightPosition: {x:14, y:16}`), sitting in the chrome gutter. When a
// FullscreenOverlay (the wizard / PR detail / create flows) opens, it owns the
// whole window and supplies its own Esc/close chip in that top-left corner — so
// we HIDE the native lights for the lifetime of the overlay, then show them
// again on close. (An earlier version parked them below the top bar instead,
// but that left three orphaned dots floating in the content area.)
//
// Tauri v2 has no JS API for either operation, so they ride tiny native
// commands (see src-tauri/cmd_window.rs). Every call is best-effort: off macOS,
// in the web preview, or before the command is wired, it silently no-ops.

import { invoke } from "@tauri-apps/api/core";

async function setHidden(hidden: boolean): Promise<void> {
  try {
    await invoke("window_set_traffic_lights_hidden", { hidden });
  } catch {
    // non-macOS, web preview, or command not present — nothing to do.
  }
}

/** Hide the native lights while an overlay owns the window. */
export function dropTrafficLightsForOverlay(): void {
  void setHidden(true);
}

/** Reveal the native lights again when the overlay closes. */
export function restoreTrafficLights(): void {
  void setHidden(false);
}
