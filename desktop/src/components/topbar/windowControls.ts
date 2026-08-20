import { useIsFullscreen } from "../../lib/useIsFullscreen";

// Room for the macOS window buttons (the red/amber/green "traffic lights")
// at the top-left of whichever chrome strip starts at the window's left edge.
//
// The window runs a custom title bar (tauri.conf.json → `titleBarStyle:
// "Overlay"`, `hiddenTitle: true`), so our content is painted from x=0/y=0
// while macOS still draws its three buttons over that corner. Anything we put
// there renders UNDERNEATH them. `trafficLightPosition: { x: 14, y: 21 }` puts
// the close button's left edge at 14px; the three sit at the system's 20px
// pitch and are ~13px across, so the cluster ends at 14 + 40 + 13 = 67px.
// GUTTER adds the same breathing room the strip's own controls give each
// other, so the first real control starts clear of the green button.
//
// Two strips can be the leftmost one, and they MUST agree — the sidebar
// header when the sidebar is open, the top bar when it is collapsed. They
// used to carry 70 and 76 by hand; the 70 was six pixels short of the button
// cluster, which is how the account chip ended up under the lights.
//
// Collapsed in fullscreen, where the corner is ours again. macOS moves the
// window buttons into the auto-hiding titlebar accessory when a window goes
// fullscreen — they are not painted over our content, so holding 76px for
// them leaves the account chip stranded in the middle of the strip with a
// visibly empty corner beside it.
//
// This has been fixed and un-fixed before, so the reasoning is worth writing
// down. The un-fix argued that `restoreTrafficLights()` (lib/trafficLights.ts)
// re-shows the lights whenever a FullscreenOverlay closes without consulting
// the window's fullscreen state, making "fullscreen means the lights are gone"
// an assumption that silently breaks. It doesn't: that call controls whether
// the buttons are HIDDEN, not where the system puts them. In fullscreen they
// live in the titlebar overlay either way, so showing them cannot put anything
// back over this corner — and it is a state the user is looking at constantly,
// not an edge case. What DOES need the reservation in every state is windowed
// mode, where the lights really are drawn over whatever we paint at x=0.
//
// 72, not 76: the cluster ends at 67 and ChromeBtn centres its 13px glyph in a
// 20px box, so the button's own 3.5px of padding is already part of the gap.
// Reserving 76 spent that padding twice — 72 leaves the button's hover wash 5px
// clear of the green light and puts the glyph's ink ~10px clear, which is the
// rhythm the rest of the strip keeps.
const GUTTER = 72;

// ...and 72 WINDOW POINTS, not 72 CSS px, which is the bug this units division
// fixes. The lights are a native overlay macOS parks at a fixed window
// position; they do not scale with the webview zoom, but every CSS px in the
// document does. So a plain `72` reserved 72pt at zoom 1 and 101pt at zoom 1.4,
// and the search button walked further from the lights the more the user zoomed
// in — measured at zoom 1.4, the glyph sat 39pt off the green button instead of
// 10. Dividing by the zoom (published as `--webview-zoom` from App.tsx) keeps
// the reservation constant in the units the lights are actually drawn in.
//
// `var(--webview-zoom, 1)` rather than bare `var(--webview-zoom)`: the variable
// is set from App's module scope, but this file has no guarantee of running
// after it, and a missing var would make the whole calc() invalid and collapse
// the gutter to nothing — straight under the lights.
const ZOOM_INVARIANT_GUTTER = `calc(${GUTTER}px / var(--webview-zoom, 1))`;

/** Windows and Linux keep their window controls on the right, so the
 *  top-left gutter would be dead space there. */
function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac/i.test(platform) || /Macintosh/i.test(ua);
}

/**
 * Left padding for a chrome strip, as a CSS length.
 *
 * Returns a `calc()` string for the gutter case and a plain number elsewhere;
 * both are valid `style` values, so callers assign it straight through.
 *
 * @param leftmost — true when this strip starts at the window's left edge and
 *   therefore shares the corner with the window buttons. A strip that sits to
 *   the right of another column (the top bar while the sidebar is open) never
 *   reserves the gutter; it just takes the normal edge padding.
 * @param fullscreen — true while the window is in macOS fullscreen, where the
 *   system owns the buttons and the corner is free. Callers that don't already
 *   track it should use `useWindowControlsInset` instead of passing a guess.
 */
export function windowControlsInset(
  leftmost: boolean,
  fullscreen = false,
): number | string {
  return leftmost && isMacOS() && !fullscreen ? ZOOM_INVARIANT_GUTTER : 8;
}

/** `windowControlsInset` for strips that don't already have the window's
 *  fullscreen state to hand — subscribes to it and re-renders on the
 *  transition, so the gutter opens and closes with the lights. */
export function useWindowControlsInset(leftmost: boolean): number | string {
  return windowControlsInset(leftmost, useIsFullscreen());
}
