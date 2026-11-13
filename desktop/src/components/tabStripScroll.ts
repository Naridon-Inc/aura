// A tab strip that scrolls, told honestly.
//
// Both strips hide their scrollbar — deliberately; a horizontal bar under a
// row of tabs is ugly and steals height from a 32px line. What neither did was
// replace what the scrollbar was for. Open enough tabs and the last one is cut
// off mid-word with no ellipsis, no bar and no edge: it reads as a rendering
// fault, not as "there is more this way". Worse, activate a tab that has
// scrolled out of view — ⌘1..9, the picker, a click in another pane — and the
// strip does not follow it, so the tab you are looking at is not on screen and
// nothing on the row is lit.
//
// This gives a strip both halves: the active tab is always scrolled into view,
// and each edge with tabs hidden behind it gets the library's scroll chevron
// (ui/workspace-tabs.tsx) — a button that moves the strip 240px that way.

import { useCallback, useEffect, useRef, useState } from "react";

/** How far one chevron click moves the strip — the library's step. */
const STEP_PX = 240;

/** Smooth unless the person asked the OS for less motion. */
function scrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export type TabStripScroll = {
  /** Put on the horizontally-scrolling element that wraps the tabs. */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** Put on whichever tab is currently active. */
  activeRef: (el: HTMLElement | null) => void;
  /** Which edges have tabs hidden behind them — show a chevron on each. */
  edges: { start: boolean; end: boolean };
  /** Move the strip one step toward that edge (-1 = start, 1 = end). */
  scrollStep: (dir: -1 | 1) => void;
};

/**
 * @param activeKey Changes whenever the active tab changes — the strip
 *                  re-scrolls to bring it into view. Include the pane id as
 *                  well as the index, or moving a tab between panes leaves the
 *                  strip parked where the old pane had it.
 */
export function useTabStripScroll(activeKey: string): TabStripScroll {
  const elRef = useRef<HTMLDivElement | null>(null);
  const activeElRef = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({
    start: false,
    end: false,
  });

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // 1px of slack: sub-pixel layout rounds scrollWidth up on zoomed webviews
    // and a permanently-lit fade over a strip with nothing hidden is a lie.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      measure();
    },
    [measure],
  );

  const activeRef = useCallback((el: HTMLElement | null) => {
    activeElRef.current = el;
  }, []);

  // Re-measure on scroll, on resize of the strip, and whenever its tabs change
  // (a ResizeObserver on the container catches a tab being added or renamed,
  // since either changes the scroll width).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure, activeKey]);

  // Follow the active tab. `nearest` on both axes so this never scrolls an
  // ancestor — the strip moves, the window does not.
  useEffect(() => {
    activeElRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    measure();
  }, [activeKey, measure]);

  const scrollStep = useCallback((dir: -1 | 1) => {
    elRef.current?.scrollBy({ left: dir * STEP_PX, behavior: scrollBehavior() });
  }, []);

  return { scrollRef, activeRef, edges, scrollStep };
}
