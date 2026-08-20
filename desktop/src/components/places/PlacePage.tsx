// The two-column shell a place gets when it owns the window.
//
// A place brings its own navigation — Pages its index of documents, Tasks its
// buckets and saved views, Team its conversation list. That navigation used to
// have nowhere to live: the app rail is the project roster, and handing it a
// second body meant your projects disappeared for as long as you stood in the
// feature. So the index went into a popover, which is the right answer for a
// surface squeezed between a rail and a right rail — and the wrong one now
// that the place has the whole window.
//
// It goes on the RIGHT. That is the app's rule, not this component's: the left
// edge belongs to the app — destinations, then your projects — and a second
// panel about the surface you're standing in opens on the other side, exactly
// where a code project's Changes and Files rails open. Two columns of
// navigation on the same edge is the thing that made the rail feel like it had
// been replaced; on opposite edges, the left one still says where you are in
// the app and the right one says where you are inside this place.
//
// It is also deliberately NOT a second copy of the app rail: narrower (220
// against 248), on the page's own ground rather than the app chrome's, one
// hairline between. A panel the same width in the same colour reads as a
// second navigation system; a narrower one in the content's own colour reads
// as part of the page — which is what it is.
//
// Team was the last surface that didn't use this. It laid out its own three
// columns with the conversation list first — a 252px list of rows standing
// immediately against the app's 248px rail of rows, which is the one
// arrangement this component exists to prevent. `TeamSurface` mounts through
// here now for the page; it still lays out its own columns for the navigator
// docked in the app sidebar, for the workpane, and below 640px, because none
// of those is a place.

// Sizing: it is a PANE, on the same mechanism as the code project's Changes /
// Checks rail. It used to be a `const` — 220px, for everyone, forever, with no
// handle on the boundary. Which made it the one second sidebar in the app you
// could not resize: a document title in Pages, a channel name in Team and a
// sprint name in Tasks all got the same 220px whether they fit in it or not,
// and the only fix was to stop using the rail. `ui/resizable` is that
// mechanism, and now this takes it, so the place rail drags, clamps,
// remembers, and gives way exactly the way the review rail does.

import { useRef, type JSX, type ReactNode } from "react";

import {
  ResizablePane,
  fitMax,
  useMeasuredWidth,
  usePaneSize,
} from "../ui/resizable";

/** Default width of a place's own panel. One step under the app rail's 248 —
 *  see the note above; the difference is the whole point. It is the width the
 *  rail OPENS at, not the width it is stuck at. */
export const PLACE_RAIL_WIDTH = 220;
/** Narrow enough for a rail of rows to still read; wide enough that a long
 *  document title or channel name doesn't have to be truncated to nothing.
 *  Deliberately not the review rail's 240–560: that rail carries diffs and a
 *  PR document, this one carries rows, so its floor is lower and its ceiling
 *  is nearer. The mechanism is shared; the bounds are each pane's own. */
const PLACE_RAIL_MIN = 180;
const PLACE_RAIL_MAX = 420;
/** What the page itself must keep. The rail is bounded against the box it is
 *  in rather than the window, because a place mounted in a workpane has far
 *  less room than the screen suggests. */
const PLACE_BODY_MIN = 360;
const PLACE_RAIL_KEY = "aura.place.rail.w";

export function PlacePage({
  rail,
  children,
}: {
  /** The place's own navigation, opened on the right. Omit for a place that
   *  has none. */
  rail?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellW = useMeasuredWidth(shellRef);
  const [railW, setRailW] = usePaneSize(
    PLACE_RAIL_KEY,
    PLACE_RAIL_WIDTH,
    PLACE_RAIL_MIN,
    PLACE_RAIL_MAX,
  );
  // The ceiling the window can actually afford right now. The STORED width is
  // left alone, so a place opened in a narrow pane borrows the rail back down
  // and the full window gives you the width you chose.
  const max = fitMax(shellW, PLACE_BODY_MIN, PLACE_RAIL_MIN, PLACE_RAIL_MAX);

  return (
    // `w-full flex-1 min-w-0` so this fills whatever it is dropped into. It
    // used to be `flex h-full` alone, which fills a block parent and collapses
    // inside a flex row — where an item with no grow is sized by its content.
    // Pages and Tasks mount straight into a block, so they were fine; Team
    // mounts through a flex row, so its shell shrink-wrapped: the page sat in
    // ~360px, the rail landed against it around a third of the way across the
    // window, and the remaining ~670px was empty. A rail that says "right
    // edge" has to be ON the right edge, so the width is this component's
    // business rather than each caller's.
    <div
      ref={shellRef}
      className="flex h-full min-h-0 w-full min-w-0 flex-1 bg-bg-content"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {rail ? (
        <ResizablePane
          edge="trailing"
          size={railW}
          min={PLACE_RAIL_MIN}
          max={max}
          onResize={setRailW}
          label="Resize panel"
          // `ade-place-rail` carries the app rail's 13px reading size (see
          // styles.css). Without it this column inherited the PAGE's base
          // size, so the second sidebar's rows, group headings and project
          // picker all came out a step larger than the identical rows in the
          // first sidebar — two columns of navigation, side by side, at two
          // different sizes. `PlaceRailRow` claims a row here is the same
          // object as a row there; this is what makes that true.
          className="ade-place-rail flex min-h-0 min-w-0 flex-col border-l-[0.5px] border-line-soft"
        >
          {rail}
        </ResizablePane>
      ) : null}
    </div>
  );
}
