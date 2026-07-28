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
// Deliberately NOT collapsed in fullscreen. macOS keeps custom-positioned
// window buttons on screen there, and the app itself re-shows them every time
// a FullscreenOverlay closes (see lib/trafficLights.ts) without consulting the
// window's fullscreen state — so "fullscreen means the lights are gone" is an
// assumption that silently breaks and drops the header's controls behind three
// native buttons. Reserving the gutter whenever we're the leftmost strip on
// macOS makes the collision impossible in every state; the cost is 76px of
// window-drag region in one corner of a strip whose middle is already empty
// drag region by design.
const GUTTER = 76;

/** Windows and Linux keep their window controls on the right, so the
 *  top-left gutter would be dead space there. */
function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac/i.test(platform) || /Macintosh/i.test(ua);
}

/**
 * Left padding for a chrome strip, in pixels.
 *
 * @param leftmost — true when this strip starts at the window's left edge and
 *   therefore shares the corner with the window buttons. A strip that sits to
 *   the right of another column (the top bar while the sidebar is open) never
 *   reserves the gutter; it just takes the normal edge padding.
 */
export function windowControlsInset(leftmost: boolean): number {
  return leftmost && isMacOS() ? GUTTER : 8;
}
