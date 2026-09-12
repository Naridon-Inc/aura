// Windowing support for lists that DON'T own their scrollbar.
//
// A few surfaces are rendered *into* somebody else's `overflow-y-auto`
// pane — a unified diff stacked under a change-note card, the agent block
// stack inside its side rail. Giving them their own scroller would add a
// second scrollbar and change the layout, so windowing has to hang off
// whichever ancestor actually scrolls. This resolves that ancestor plus
// the list's offset inside it: exactly the two inputs `useVirtualizer`
// wants for `getScrollElement` and `scrollMargin`.
//
// When nothing above the list scrolls, `element` is null and callers fall
// back to rendering every row — correct, just slower.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type ScrollHost = {
  /** Nearest scrollable ancestor, or null when nothing above scrolls. */
  element: HTMLElement | null;
  /** Distance from the host's content top down to the list's top edge. */
  margin: number;
};

const NO_HOST: ScrollHost = { element: null, margin: 0 };

function findScrollHost(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    // `auto`/`scroll` count even when the content doesn't overflow yet —
    // that element is still the one that WILL scroll once it does.
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
    node = node.parentElement;
  }
  return null;
}

export function useScrollHost(ref: RefObject<HTMLElement | null>): ScrollHost {
  const [host, setHost] = useState<ScrollHost>(NO_HOST);
  // Mirror of the state so `measure` can compare without re-subscribing.
  const latest = useRef(host);
  latest.current = host;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = findScrollHost(el);
    // Adding scrollTop back makes the margin independent of where the
    // user currently is, so scrolling never re-triggers this.
    const margin = scroller
      ? el.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      : 0;
    const prev = latest.current;
    if (prev.element === scroller && Math.abs(prev.margin - margin) < 1) return;
    setHost({ element: scroller, margin });
  }, [ref]);

  // Deliberately un-keyed: content ABOVE the list (a note card finishing
  // its fetch) shifts the margin without touching the list itself, and no
  // observer fires for that. Two getBoundingClientRect calls per render is
  // cheap, and state only moves when the offset genuinely changed.
  useLayoutEffect(() => {
    measure();
  });

  useLayoutEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return host;
}
