// Turning a DOM wheel event into terminal scrollback lines.
//
// On macOS the GPU surface takes the wheel itself and this never runs — the
// event is handled before the webview sees it. Everywhere else the DOM hole is
// still the only thing that hears a wheel, so this is the path that has to be
// right.
//
// Two things make a wheel handler harder than it looks:
//
//   * A trackpad reports a few pixels at a time, far less than one line.
//     Rounding each event on its own throws all of it away, so a slow scroll
//     moves nothing at all; the leftover has to survive between events.
//   * A gesture is not only its movement. macOS sends a wheel event with a
//     delta of exactly zero when a gesture begins and again when it ends, so
//     any handler that asks "is the delta negative?" and treats everything
//     else as downward scrolls *down* twice per gesture — enough to cancel the
//     gesture that was meant to scroll up.
//
// Line counts here follow the terminal's own convention: positive goes back
// into scrollback, negative returns toward the live prompt. That is the
// opposite sign to `WheelEvent.deltaY`, which is positive scrolling down.

/** Lines moved per notch of a notched wheel, matching the native path. */
export const LINES_PER_NOTCH = 3;

/** Lines a page-mode wheel event moves. Only legacy browsers send these. */
const DEFAULT_LINES_PER_PAGE = 24;

/** The parts of a `WheelEvent` that matter. */
export type WheelLike = {
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.DOM_DELTA_*`). */
  deltaMode: number;
};

/** Carries the fraction of a line a gesture has moved but not yet spent. */
export type WheelAccumulator = { rest: number };

export function createWheelAccumulator(): WheelAccumulator {
  return { rest: 0 };
}

/**
 * How many scrollback lines a wheel event should move.
 *
 * `cellHeightPx` is the line height in the same CSS pixels the event measures
 * its delta in. Returns 0 when the gesture has not yet crossed a line.
 */
export function wheelToLines(
  event: WheelLike,
  accumulator: WheelAccumulator,
  cellHeightPx: number,
  linesPerPage: number = DEFAULT_LINES_PER_PAGE,
): number {
  // The DOM counts down as positive; scrollback counts back as positive.
  const delta = -event.deltaY;
  if (!Number.isFinite(delta) || delta === 0) {
    return 0;
  }

  // Already whole lines — a notch, or a browser reporting in lines.
  if (event.deltaMode === 1) {
    accumulator.rest = 0;
    return Math.round(delta);
  }
  if (event.deltaMode === 2) {
    accumulator.rest = 0;
    return Math.round(delta) * linesPerPage;
  }

  const height = Number.isFinite(cellHeightPx) && cellHeightPx >= 1 ? cellHeightPx : 1;
  // Reversing direction mid-gesture abandons what was pending, so a flick back
  // does not have to pay off the old remainder before it moves.
  if (accumulator.rest !== 0 && Math.sign(accumulator.rest) !== Math.sign(delta)) {
    accumulator.rest = 0;
  }
  accumulator.rest += delta;
  const lines = Math.trunc(accumulator.rest / height);
  accumulator.rest -= lines * height;
  return lines;
}
