import { describe, expect, test } from "bun:test";
import {
  INITIAL_PAN_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  applyPinch,
  applyWheel,
  focalPoint,
  panZoomTransform,
  stepIn,
  stepOut,
  wheelFactor,
  wheelPixels,
  zoomAbout,
} from "./panZoom";

const bounds = { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
const rect = { left: 100, top: 50, width: 400, height: 200 };

describe("zooming a diagram", () => {
  test("a point under the cursor stays put while zooming about it", () => {
    const focal = { x: 40, y: 30 };
    const next = zoomAbout(INITIAL_PAN_ZOOM, 2, { ...bounds, focal });
    // screen = offset + zoom * picture; the picture point under the cursor was (40, 30)
    expect(next.offset.x + next.zoom * 40).toBe(40);
    expect(next.offset.y + next.zoom * 30).toBe(30);
  });

  test("zoom stays between the smallest and the largest", () => {
    expect(zoomAbout(INITIAL_PAN_ZOOM, 50, bounds).zoom).toBe(MAX_ZOOM);
    expect(zoomAbout(INITIAL_PAN_ZOOM, 0.01, bounds).zoom).toBe(MIN_ZOOM);
  });

  test("reaching the smallest zoom puts the diagram back in the middle", () => {
    const moved = { ...INITIAL_PAN_ZOOM, zoom: 2, offset: { x: 80, y: -20 } };
    expect(zoomAbout(moved, 0.1, bounds).offset).toEqual({ x: 0, y: 0 });
    expect(stepOut({ ...moved, zoom: MIN_ZOOM * 1.1 }, MIN_ZOOM).offset).toEqual({ x: 0, y: 0 });
  });

  test("the buttons step by 1.15 and keep where the diagram was moved to", () => {
    const moved = { ...INITIAL_PAN_ZOOM, offset: { x: 10, y: 5 } };
    const bigger = stepIn(moved, MAX_ZOOM);
    expect(bigger.zoom).toBeCloseTo(1.15);
    expect(bigger.offset).toEqual({ x: 10, y: 5 });
    const smaller = stepOut(moved, MIN_ZOOM);
    expect(smaller.zoom).toBeCloseTo(1 / 1.15);
    expect(smaller.offset).toEqual({ x: 10, y: 5 });
    expect(stepIn({ ...moved, zoom: MAX_ZOOM }, MAX_ZOOM).zoom).toBe(MAX_ZOOM);
  });

  test("the focal point is measured from the frame's middle when it zooms from the middle", () => {
    expect(focalPoint(300, 150, rect, "center")).toEqual({ x: 0, y: 0 });
    expect(focalPoint(300, 150, rect, "top-left")).toEqual({ x: 200, y: 100 });
  });
});

describe("the wheel and the trackpad", () => {
  test("lines and pages are turned into pixels", () => {
    expect(wheelPixels({ deltaMode: 0, deltaX: 3, deltaY: 4 }, rect)).toEqual({ x: 3, y: 4 });
    expect(wheelPixels({ deltaMode: 1, deltaX: 1, deltaY: 2 }, rect)).toEqual({ x: 16, y: 32 });
    expect(wheelPixels({ deltaMode: 2, deltaX: 1, deltaY: 1 }, rect)).toEqual({ x: 400, y: 200 });
  });

  test("scrolling up 100px zooms in one step; a pinch follows the fingers", () => {
    expect(wheelFactor(-100, false)).toBeCloseTo(1.15);
    expect(wheelFactor(100, false)).toBeCloseTo(1 / 1.15);
    expect(wheelFactor(-10, true)).toBeCloseTo(Math.exp(0.1));
  });

  test("a plain scroll pans a zoomed-in diagram only when asked to", () => {
    const zoomed = { ...INITIAL_PAN_ZOOM, zoom: 2 };
    const e = { deltaMode: 0, deltaX: 5, deltaY: 10, ctrlKey: false, metaKey: false };
    const panned = applyWheel(zoomed, e, { x: 0, y: 0 }, rect, { ...bounds, scrollPans: true });
    expect(panned).toEqual({ ...zoomed, offset: { x: -5, y: -10 } });
    const zoomedOut = applyWheel(zoomed, e, { x: 0, y: 0 }, rect, bounds);
    expect(zoomedOut.zoom).toBeLessThan(2);
    const pinch = applyWheel(zoomed, { ...e, ctrlKey: true }, { x: 0, y: 0 }, rect, { ...bounds, scrollPans: true });
    expect(pinch.zoom).toBeLessThan(2);
  });

  test("spreading two fingers zooms and drags with their middle", () => {
    const start = { ...INITIAL_PAN_ZOOM, pinch: { distance: 100, midpoint: { x: 300, y: 150 } } };
    const next = applyPinch(start, 200, { x: 310, y: 150 }, rect, "center", bounds);
    expect(next.zoom).toBe(2);
    expect(next.pinch).toEqual({ distance: 200, midpoint: { x: 310, y: 150 } });
    // the middle moved 10px right; focal is 10px right of the frame's middle
    expect(next.offset.x).toBe(10 - 2 * 10 + 10);
    expect(applyPinch(INITIAL_PAN_ZOOM, 200, { x: 0, y: 0 }, rect, "center", bounds)).toBe(INITIAL_PAN_ZOOM);
  });

  test("the drawn transform", () => {
    const s = { ...INITIAL_PAN_ZOOM, zoom: 1.5, offset: { x: 4, y: -2 } };
    expect(panZoomTransform(s, "center")).toEqual({
      transform: "translate(4px, -2px) scale(1.5)",
      transformOrigin: "center",
      touchAction: "none",
    });
    expect(panZoomTransform(s, "top-left").transformOrigin).toBe("0 0");
  });
});
