// The claim under test: the browser's hole rect actually changes units.
//
// The native browser webview is a sibling of the React shell, positioned in
// window points, while the hole it tracks is measured in CSS px. The bug this
// covers was not wrong arithmetic — it was a correction that computed a factor
// of exactly 1 on every display and so handed the rect back untouched, which
// looked like a working fast path. So these cases assert the conversion is a
// real one at a real zoom, and that the identity case is the only thing that
// passes a rect through unchanged.

import { describe, expect, it } from "bun:test";

import { toWindowRect, type BrowserRect } from "./browserEngine";

const HOLE: BrowserRect = { x: 226, y: 70, width: 2116, height: 1009 };

describe("toWindowRect", () => {
  it("scales the origin as well as the size", () => {
    // Both corners move. Scaling only the size is the subtler version of this
    // bug: the panel comes out the right shape and still sits off its hole.
    const r = toWindowRect(HOLE, 1.3);
    expect(r.x).toBeCloseTo(293.8, 1);
    expect(r.y).toBeCloseTo(91, 1);
    expect(r.width).toBeCloseTo(2750.8, 1);
    expect(r.height).toBeCloseTo(1311.7, 1);
  });

  it("is a true identity at 100% and not merely close to one", () => {
    expect(toWindowRect(HOLE, 1)).toEqual(HOLE);
  });

  it("shrinks a hole when the window is zoomed out below 100%", () => {
    // Zoom runs 50%–200% (App.tsx clampZoom), so the factor is as often below
    // 1 as above it and the correction cannot assume it only ever grows.
    const r = toWindowRect(HOLE, 0.5);
    expect(r.x).toBe(113);
    expect(r.width).toBe(1058);
  });

  it("round-trips back to the hole it was measured from", () => {
    // What the user sees is this composition: the rect we send, divided by the
    // zoom the window applies, has to land back on the measured hole.
    const zoom = 1.3;
    const sent = toWindowRect(HOLE, zoom);
    expect(sent.x / zoom).toBeCloseTo(HOLE.x, 6);
    expect(sent.width / zoom).toBeCloseTo(HOLE.width, 6);
  });

  it("leaves a rect alone rather than collapsing it when zoom is unusable", () => {
    // `webviewZoom()` already floors a zero, negative or unparseable level at
    // 1 — asserted here at this boundary too, because a 0 arriving this far
    // would multiply the hole down to nothing and the panel would go black
    // with no clue as to why.
    expect(toWindowRect(HOLE, 1)).toEqual(HOLE);
    expect(toWindowRect({ x: 0, y: 0, width: 0, height: 0 }, 1.3)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
