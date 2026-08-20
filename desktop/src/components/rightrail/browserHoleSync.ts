// Keeping a native OS window lined up with a hole in a React layout.
//
// The browser panel's webview is not a DOM node — it is a real window the
// platform floats over everything React draws. Nothing tells us when it drifts,
// so `RailBrowser` reconciles it on a 400ms tick as well as on every layout
// event it can observe. That tick has to keep firing (a pane animating, a zoom
// change, a scroll under an absolutely-positioned hole are all moves nothing
// observes), which makes the two decisions below load-bearing: what counts as a
// move, and what a tick actually has to say.

import type { BrowserRect } from "../../lib/browserEngine";

/** What we last told the native layer about a tab. */
export type NativeBelief = { bounds: string; shown: boolean };

/** Bounds as a comparable string, rounded to whole pixels.
 *
 *  Sub-pixel jitter in a `getBoundingClientRect` is not a move: repositioning a
 *  native OS window by a third of a pixel costs a real IPC round-trip and
 *  changes nothing anyone can see. */
export function boundsKey(r: BrowserRect): string {
  return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
}

/** Which native calls a reconcile actually has to make.
 *
 *  The 400ms tick below exists to catch layout moves that neither the store nor
 *  the ResizeObserver sees — a pane animating, a zoom change, a scroll under an
 *  absolutely-positioned hole. It has to keep firing. But in the overwhelmingly
 *  common case nothing has moved, and re-sending identical bounds plus a repeat
 *  show is two IPC round-trips to the native layer, two and a half times a
 *  second, for the entire life of the panel — whether or not the Browser tab is
 *  the one you are looking at, because the rail hides tabs rather than
 *  unmounting them.
 *
 *  `resync` is what keeps the safety net a safety net: every tenth tick sends
 *  regardless, so a native layer that drifted without the DOM rect changing
 *  still heals itself, just a few seconds later instead of instantly. */
export function nativeWork(
  believed: NativeBelief | undefined,
  rect: BrowserRect,
  resync: boolean,
): { setBounds: boolean; show: boolean } {
  return {
    setBounds: resync || believed?.bounds !== boundsKey(rect),
    show: resync || believed?.shown !== true,
  };
}
