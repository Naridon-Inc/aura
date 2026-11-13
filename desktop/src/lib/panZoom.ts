// Zoom and pan for a picture inside a frame — a diagram opened full size.
//
// The state is a scale and an offset; the picture is drawn with
// `translate(offset) scale(zoom)`. Zooming about a point (the cursor, the
// middle of a pinch) keeps that point where it was on screen. At the
// smallest zoom the picture snaps back to the middle. A trackpad pinch
// arrives as a wheel event with ctrlKey held; a mouse wheel zooms by the
// same step the buttons use, scaled by how far it turned.

export type Point = { x: number; y: number };

export type PanZoomState = {
  zoom: number;
  offset: Point;
  /** A two-finger touch in progress: the gap between the fingers and their
   *  middle, both from the last move. */
  pinch: { distance: number; midpoint: Point } | null;
};

export type TransformOrigin = "top-left" | "center";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 1.15;
/** Wheel pixels that make one zoom step. */
const WHEEL_PIXELS_PER_STEP = 100;
/** Pixels in one wheel "line" (Firefox reports lines). */
const LINE_PIXELS = 16;
/** How hard a trackpad pinch zooms per pixel of wheel delta. */
const PINCH_RATE = 0.01;

export const INITIAL_PAN_ZOOM: PanZoomState = { zoom: 1, offset: { x: 0, y: 0 }, pinch: null };

export type Bounds = { minZoom: number; maxZoom: number };

/** A point on screen measured from where the picture's transform starts. */
export function focalPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  origin: TransformOrigin,
): Point {
  const ox = origin === "center" ? rect.width / 2 : 0;
  const oy = origin === "center" ? rect.height / 2 : 0;
  return { x: clientX - rect.left - ox, y: clientY - rect.top - oy };
}

/** Zoom to `next` (clamped), keeping `focal` fixed on screen and then moving
 *  by `pan`. Hitting the smallest zoom puts the picture back in the middle. */
export function zoomAbout(
  state: PanZoomState,
  next: number,
  { minZoom, maxZoom, focal = { x: 0, y: 0 }, pan = { x: 0, y: 0 } }: Bounds & {
    focal?: Point;
    pan?: Point;
  },
): PanZoomState {
  const zoom = Math.min(maxZoom, Math.max(minZoom, next));
  const ratio = zoom / state.zoom;
  return {
    ...state,
    zoom,
    offset:
      zoom === minZoom
        ? { x: 0, y: 0 }
        : {
            x: focal.x - ratio * (focal.x - state.offset.x) + pan.x,
            y: focal.y - ratio * (focal.y - state.offset.y) + pan.y,
          },
  };
}

/** The zoom-in button: one step larger, offset kept. */
export function stepIn(state: PanZoomState, maxZoom: number, step = ZOOM_STEP): PanZoomState {
  return { ...state, zoom: Math.min(state.zoom * step, maxZoom) };
}

/** The zoom-out button: one step smaller; at the smallest, back to the middle. */
export function stepOut(state: PanZoomState, minZoom: number, step = ZOOM_STEP): PanZoomState {
  const zoom = Math.max(state.zoom / step, minZoom);
  return { ...state, zoom, offset: zoom === minZoom ? { x: 0, y: 0 } : state.offset };
}

/** A wheel event's movement in pixels, whatever unit the device reported. */
export function wheelPixels(
  e: { deltaMode: number; deltaX: number; deltaY: number },
  rect: { width: number; height: number },
): Point {
  if (e.deltaMode === 1) return { x: e.deltaX * LINE_PIXELS, y: e.deltaY * LINE_PIXELS };
  if (e.deltaMode === 2) return { x: e.deltaX * rect.width, y: e.deltaY * rect.height };
  return { x: e.deltaX, y: e.deltaY };
}

/** How much one wheel event scales the zoom: a pinch (ctrlKey) follows the
 *  fingers smoothly, a wheel turns in steps. */
export function wheelFactor(deltaY: number, pinch: boolean, step = ZOOM_STEP): number {
  return pinch ? Math.exp(-deltaY * PINCH_RATE) : step ** (-deltaY / WHEEL_PIXELS_PER_STEP);
}

/** One wheel event applied. When `scrollPans` is on and the picture is
 *  zoomed in, a plain scroll moves it instead; a pinch or ⌘-scroll still zooms. */
export function applyWheel(
  state: PanZoomState,
  e: { deltaMode: number; deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean },
  focal: Point,
  rect: { width: number; height: number },
  { minZoom, maxZoom, step = ZOOM_STEP, scrollPans = false }: Bounds & {
    step?: number;
    scrollPans?: boolean;
  },
): PanZoomState {
  const d = wheelPixels(e, rect);
  const zoomGesture = e.ctrlKey || e.metaKey;
  if (scrollPans && !zoomGesture && state.zoom > minZoom) {
    return { ...state, offset: { x: state.offset.x - d.x, y: state.offset.y - d.y } };
  }
  return zoomAbout(state, state.zoom * wheelFactor(d.y, e.ctrlKey, step), {
    minZoom,
    maxZoom,
    focal,
  });
}

export function touchDistance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function touchMidpoint(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/** A pinch moved: scale by how much the fingers spread, about their middle,
 *  and follow the middle as it moves. */
export function applyPinch(
  state: PanZoomState,
  distance: number,
  midpoint: Point,
  rect: { left: number; top: number; width: number; height: number },
  origin: TransformOrigin,
  bounds: Bounds,
): PanZoomState {
  if (!state.pinch) return state;
  const focal = focalPoint(midpoint.x, midpoint.y, rect, origin);
  const pan = { x: midpoint.x - state.pinch.midpoint.x, y: midpoint.y - state.pinch.midpoint.y };
  return {
    ...zoomAbout(state, state.zoom * (distance / state.pinch.distance), { ...bounds, focal, pan }),
    pinch: { distance, midpoint },
  };
}

/** The style that draws the picture at this zoom and offset. */
export function panZoomTransform(state: PanZoomState, origin: TransformOrigin) {
  return {
    transform: `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.zoom})`,
    transformOrigin: origin === "center" ? "center" : "0 0",
    touchAction: "none" as const,
  };
}
