//! How much of a pane a floating composer is standing on.
//!
//! A composer that overlays a content surface has to give that surface its
//! last line back, or the thing you are reading ends underneath the thing you
//! are typing into. This is done with one custom property: the
//! composer publishes the height of its collapsed strip, and every scrollable
//! surface in the pane reserves that much at its bottom edge. One number, read
//! by whoever needs it, and nothing has to know where the composer is mounted.
//!
//! Two decisions here go further than that, and both come from
//! the same fact: our terminal is a native GPU surface placed at the hole this
//! page leaves for it, not an element in it.
//!
//!   * **Only the COLLAPSED height is ever published.** A constant (25px) would
//!     do for a strip that cannot grow; ours is measured,
//!     because ours is built out of tokens and a dock's padding and would drift
//!     the moment either changed. But measuring means the number moves as the
//!     composer grows, and publishing a growing number would resize the
//!     terminal — a swapchain reconfigure and a PTY `SIGWINCH` — on the line
//!     where a draft wraps. So the sample is taken while the composer is a
//!     strip and held while it is a box.
//!   * **The expanded box is an overlay instead**, declared with
//!     `data-over-native-surface`, which is the existing route for anything
//!     that has to be drawn across a native pane (see `nativeSurfacePlacement`).
//!     It costs one clip on open and one on close, which is two for an
//!     interaction the user asked for, rather than one per wrapped line.

import { useEffect, type RefObject } from "react";

/** The property a pane reserves room with, and the attribute that marks which
 *  ancestor holds it. Exported so the stylesheet's side of the contract can be
 *  asserted rather than hoped for. */
export const COMPOSER_OVERLAY_HEIGHT_VAR = "--composer-overlay-height";
export const COMPOSER_UNDERLAY_ATTR = "data-composer-underlay";
/** `nativeSurfacePlacement`'s opt-in: a pane clips its own hole around
 *  anything carrying this, which is the only way to be drawn across a native
 *  GPU surface. Set here rather than on the card, because what has to be
 *  clipped is the whole band — a permission card docked above the composer is
 *  as unreadable behind a terminal as the composer is. */
const OVER_NATIVE_ATTR = "data-over-native-surface";

/** The marker a collapsed composer already carries. Whether the band is worth
 *  measuring is read off the DOM rather than passed in, because this attribute
 *  IS that fact — threading a second copy of it down through the transcript
 *  would only create something that can disagree with the stylesheet.
 *
 *  The value has to be named: the box writes the attribute on every render,
 *  `"false"` while it is open, so a bare presence test matches an open box too
 *  and the terminal is resized each time a draft wraps. This is the same
 *  selector the stylesheet folds the box with. */
export const MINIMIZED_SELECTOR = '[data-composer-minimized="true"]';

/** Publish the composer band's height to the nearest marked ancestor for as
 *  long as the composer is overlaying something.
 *
 *  `el` is the whole band — the dock, not the card inside it — because what a
 *  pane has to clear is everything drawn over it, padding included.
 *
 *  @param active  the composer is an overlay at all. False in the conversation
 *                 view, where the composer is a sibling below the transcript
 *                 and nothing should be reserved for it. */
export function useComposerOverlayHeight(
  el: RefObject<HTMLElement | null>,
  { active }: { active: boolean },
): void {
  useEffect(() => {
    const band = el.current;
    if (!band) return;
    const found = band.closest(`[${COMPOSER_UNDERLAY_ATTR}]`);
    if (!(found instanceof HTMLElement)) return;
    const host = found;

    if (!active) {
      host.style.removeProperty(COMPOSER_OVERLAY_HEIGHT_VAR);
      band.removeAttribute(OVER_NATIVE_ATTR);
      return;
    }

    const reconcile = () => {
      const minimized = band.querySelector(MINIMIZED_SELECTOR) != null;
      // Collapsed, the band is not an overlay at all: its height has been
      // reserved below, so it and the pane never meet and asking for a clip
      // would cost the pane a hairline for nothing. Expanded, it genuinely is
      // one. (Setting an attribute changes no geometry, so this cannot drive
      // the observer that called it.)
      if (minimized) band.removeAttribute(OVER_NATIVE_ATTR);
      else band.setAttribute(OVER_NATIVE_ATTR, "");

      // Expanded: hold the last strip height. The observer still fires — the
      // band just grew — and this is the line that declines to pass that on.
      if (!minimized) return;
      const h = band.getBoundingClientRect().height;
      // A pane mid-mount, or one in a tab that is not showing, measures 0 —
      // reserving nothing for a composer that is about to be 40px tall would
      // hand the terminal a size it has to give straight back.
      if (h <= 0) return;
      host.style.setProperty(COMPOSER_OVERLAY_HEIGHT_VAR, `${Math.round(h)}px`);
    };

    reconcile();
    const observer = new ResizeObserver(reconcile);
    observer.observe(band);
    return () => observer.disconnect();
  }, [el, active]);

  // Leaving the pane entirely has to clear the reservation, or a terminal
  // whose composer was unmounted keeps a strip of padding nothing is in.
  useEffect(() => {
    const node = el.current;
    const host = node?.closest(`[${COMPOSER_UNDERLAY_ATTR}]`) ?? null;
    return () => {
      if (host instanceof HTMLElement) host.style.removeProperty(COMPOSER_OVERLAY_HEIGHT_VAR);
      node?.removeAttribute(OVER_NATIVE_ATTR);
    };
  }, [el]);
}
