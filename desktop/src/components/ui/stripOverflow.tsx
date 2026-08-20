// A horizontal strip of places — tabs, sections — that has more places than
// the bar hands it, and says so.
//
// Cells in a strip like this refuse to shrink, because a tab squeezed to half
// a word is not a tab. Overflow is therefore the design, and every strip in
// this app already scrolled. What none of them did was ADMIT it: the bar is
// hidden on purpose, there was no fade and no arrow, so a header narrow enough
// to show one cell presented that cell as if it were the whole set. The places
// past the edge were not merely offscreen — they were unannounced, and
// unreachable with a mouse.
//
// This lives on its own rather than inside `ViewTabs` because the same strip
// was hand-rolled twice: `.ade-tabs` for a surface's List/Board/Graph, and
// `nav.slack-channel-tabs` for a conversation's Messages/Canvas/Files, which
// clipped "Files & links" to "Fil" and put the add-tab button entirely past
// the edge. One of them getting the fix and the other not is exactly the
// "one surface remembered, the rest didn't" drift these shared pieces exist
// to end.

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

export interface StripEdges {
  left: boolean;
  right: boolean;
}

export interface StripOverflow<T extends HTMLElement> {
  /** Put this on the scrolling box itself, not the wrapper. */
  ref: React.RefObject<T | null>;
  /** Which sides have places on them you cannot currently see. */
  hidden: StripEdges;
  /** Scroll most of a screenful toward one edge. */
  page: (dir: -1 | 1) => void;
}

export function useStripOverflow<T extends HTMLElement>({
  active,
  activeSelector,
  count,
}: {
  /** The selected place. Changing it re-reveals and re-measures. */
  active?: string;
  /** How the selected cell identifies itself, e.g. `[aria-selected="true"]`. */
  activeSelector?: string;
  /** How many places there are, so adding or removing one re-measures. */
  count?: number;
} = {}): StripOverflow<T> {
  const ref = React.useRef<T>(null);
  const [hidden, setHidden] = React.useState<StripEdges>({
    left: false,
    right: false,
  });

  const measure = React.useCallback(() => {
    const box = ref.current;
    if (!box) return;
    // A pixel of slack: fractional widths make an exactly-fitting strip report
    // a sliver of overflow, which would light an arrow that scrolls nowhere.
    const end = box.scrollWidth - box.clientWidth;
    setHidden((prev) => {
      const next = { left: box.scrollLeft > 1, right: box.scrollLeft < end - 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  // Bring the selected cell into view when the strip is wider than its bar —
  // without this the place you are actually on can be the one hanging off the
  // edge.
  //
  // Scrolls the strip itself rather than calling `scrollIntoView`, which walks
  // up and can move the whole surface under the header to satisfy a 40px nudge
  // in here.
  React.useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const cell = activeSelector
      ? box.querySelector<HTMLElement>(activeSelector)
      : null;
    if (cell && box.scrollWidth > box.clientWidth) {
      const left = cell.offsetLeft;
      const right = left + cell.offsetWidth;
      if (left < box.scrollLeft) box.scrollLeft = left;
      else if (right > box.scrollLeft + box.clientWidth) {
        box.scrollLeft = right - box.clientWidth;
      }
    }
    measure();
  }, [active, activeSelector, count, measure]);

  // The bar is the thing that changes width — dragging the place rail or the
  // window is what took a strip from three cells to one — so watch the box,
  // not just the place list.
  React.useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    box.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      box.removeEventListener("scroll", measure);
    };
  }, [measure]);

  const page = React.useCallback((dir: -1 | 1) => {
    const box = ref.current;
    if (!box) return;
    // Most of a screenful, so a page always clears at least one whole cell
    // even when the slot is narrower than the floor a cell sits at.
    box.scrollBy({
      left: dir * Math.max(96, box.clientWidth * 0.8),
      behavior: "smooth",
    });
  }, []);

  return { ref, hidden, page };
}

/**
 * The two edge arrows. Render inside a `.ade-strip-wrap` next to the scrolling
 * box; only the edges that hide something appear.
 */
export function StripArrows({
  hidden,
  page,
  noun = "views",
}: {
  hidden: StripEdges;
  page: (dir: -1 | 1) => void;
  /** What the places are called, for the label a screen reader hears. */
  noun?: string;
}) {
  return (
    <>
      {/* Out of the tab ORDER but not out of the accessibility tree. Tab still
          goes strip → actions in one press, because Left/Right are how a
          keyboard walks a strip and these would only be two more stops on the
          way out. They stay announceable because a pointer is not the same
          thing as a mouse: assistive pointers and anything driving the app hit
          the tree, and an unlabelled `aria-hidden` div is nothing to them —
          which is the same "unreachable place" this whole piece is about. */}
      {hidden.left && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show earlier ${noun}`}
          title={`Show earlier ${noun}`}
          className="ade-strip-more left"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => page(-1)}
        >
          <ChevronLeft size={13} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      {hidden.right && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show more ${noun}`}
          title={`Show more ${noun}`}
          className="ade-strip-more right"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => page(1)}
        >
          <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </>
  );
}
