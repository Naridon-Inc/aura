// The browser panel's native webview is a real OS window floating over React,
// so a "hole" in the layout has to be kept in sync with it by hand. A 400ms
// tick does that, on top of a ResizeObserver and a window resize listener, and
// it has to keep ticking: a pane animating, a zoom change, a scroll under an
// absolutely-positioned hole are all moves nothing else observes.
//
// What it must not do is re-send the same bounds and a repeat show two and a
// half times a second forever. The rail hides tabs with a CSS class rather than
// unmounting them, so once the Browser tab has been opened once, that traffic
// never stops — whether or not you are looking at it.
//
// These are the two decisions that turn the tick quiet without turning off the
// safety net: what counts as a move, and what a tick actually has to say.

import { describe, expect, it } from "bun:test";

import { boundsKey, nativeWork } from "../src/components/rightrail/browserHoleSync";

const RECT = { x: 100, y: 40, width: 800, height: 600 };
/** What we would have told the native layer about `RECT`. */
const BELIEVED = { bounds: boundsKey(RECT), shown: true };

describe("what counts as a move", () => {
  it("treats sub-pixel jitter as the same place", () => {
    // getBoundingClientRect returns fractions on a scaled display. Moving a
    // native OS window by a third of a pixel costs a real IPC round-trip and
    // changes nothing anyone can see.
    expect(boundsKey({ x: 100.2, y: 40.4, width: 800.1, height: 599.6 })).toBe(
      boundsKey(RECT),
    );
  });

  it("treats a whole-pixel move as a move", () => {
    expect(boundsKey({ ...RECT, x: 101 })).not.toBe(boundsKey(RECT));
  });

  it("distinguishes every side of the rect", () => {
    // A key that collapsed two dimensions would leave the webview stranded at
    // its old size after a resize that kept the same origin.
    const keys = new Set([
      boundsKey(RECT),
      boundsKey({ ...RECT, x: RECT.x + 5 }),
      boundsKey({ ...RECT, y: RECT.y + 5 }),
      boundsKey({ ...RECT, width: RECT.width + 5 }),
      boundsKey({ ...RECT, height: RECT.height + 5 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("keeps the four numbers apart", () => {
    // Joined without separators these are both "12345", and a hole at x=1
    // would look identical to one at x=12 — a webview left a pixel wrong on
    // exactly the layouts where the digits happen to line up.
    expect(boundsKey({ x: 1, y: 23, width: 4, height: 5 })).not.toBe(
      boundsKey({ x: 12, y: 3, width: 4, height: 5 }),
    );
  });
});

describe("what a tick has to say", () => {
  it("says nothing when the native layer already believes it", () => {
    // This is the common case, ~2.5 times a second, forever. Both false is the
    // whole point of the change.
    expect(nativeWork(BELIEVED, RECT, false)).toEqual({
      setBounds: false,
      show: false,
    });
  });

  it("moves the webview when the hole moved", () => {
    expect(nativeWork(BELIEVED, { ...RECT, y: 120 }, false)).toEqual({
      setBounds: true,
      show: false,
    });
  });

  it("shows a tab it has never spoken to", () => {
    // No belief at all — a tab created this tick. Bounds have to be set before
    // it is shown, or it paints once at the wrong place.
    expect(nativeWork(undefined, RECT, false)).toEqual({
      setBounds: true,
      show: true,
    });
  });

  it("re-shows a tab it believes is hidden", () => {
    expect(nativeWork({ bounds: boundsKey(RECT), shown: false }, RECT, false)).toEqual(
      { setBounds: false, show: true },
    );
  });

  it("says everything on a resync even when nothing changed", () => {
    // Every tenth tick, ~4 seconds. This is what keeps the tick a safety net:
    // a native layer that drifted without the DOM rect changing still heals
    // itself, just a few seconds later instead of instantly.
    expect(nativeWork(BELIEVED, RECT, true)).toEqual({
      setBounds: true,
      show: true,
    });
  });

  it("resyncs a tab it has no belief about too", () => {
    expect(nativeWork(undefined, RECT, true)).toEqual({
      setBounds: true,
      show: true,
    });
  });
});
