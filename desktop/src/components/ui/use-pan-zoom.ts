// Zoom and pan for a picture in a frame: the wheel and a trackpad pinch zoom
// about the cursor, a drag moves it, two fingers pinch and drag, and the
// buttons step in and out. Spread `containerProps` on the frame and `style`
// on the picture inside it. The rules are in lib/panZoom.

import { useCallback, useEffect, useState, type MouseEvent, type TouchEvent } from "react";

import {
  INITIAL_PAN_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  applyPinch,
  applyWheel,
  focalPoint,
  panZoomTransform,
  stepIn,
  stepOut,
  touchDistance,
  touchMidpoint,
  zoomAbout,
  type PanZoomState,
  type Point,
  type TransformOrigin,
} from "../../lib/panZoom";

export type PanZoomOptions = {
  enabled?: boolean;
  minZoom?: number;
  maxZoom?: number;
  zoomStep?: number;
  transformOrigin?: TransformOrigin;
  /** Once zoomed in, a plain scroll moves the picture; ⌘ or a pinch zooms. */
  scrollPansWhenZoomed?: boolean;
};

export function usePanZoom({
  enabled = true,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
  zoomStep = ZOOM_STEP,
  transformOrigin = "top-left",
  scrollPansWhenZoomed = false,
}: PanZoomOptions = {}) {
  const [state, setState] = useState<PanZoomState>(INITIAL_PAN_ZOOM);
  const [isPanning, setPanning] = useState(false);
  const [grab, setGrab] = useState<Point>({ x: 0, y: 0 });
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const bounds = { minZoom, maxZoom };

  const resetView = useCallback(() => setState(INITIAL_PAN_ZOOM), []);
  const zoomIn = useCallback(() => setState((s) => stepIn(s, maxZoom, zoomStep)), [maxZoom, zoomStep]);
  const zoomOut = useCallback(() => setState((s) => stepOut(s, minZoom, zoomStep)), [minZoom, zoomStep]);
  const zoomTo = useCallback(
    ({ zoom, clientX, clientY }: { zoom: number; clientX?: number; clientY?: number }) => {
      const focal =
        frame && clientX !== undefined && clientY !== undefined
          ? focalPoint(clientX, clientY, frame.getBoundingClientRect(), transformOrigin)
          : undefined;
      setState((s) => zoomAbout(s, zoom, { minZoom, maxZoom, focal }));
    },
    [frame, minZoom, maxZoom, transformOrigin],
  );

  // React's onWheel is passive, so the page would scroll too; listen directly.
  useEffect(() => {
    if (!enabled || !frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = frame.getBoundingClientRect();
      const focal = focalPoint(e.clientX, e.clientY, rect, transformOrigin);
      setState((s) =>
        applyWheel(s, e, focal, rect, {
          minZoom,
          maxZoom,
          step: zoomStep,
          scrollPans: scrollPansWhenZoomed,
        }),
      );
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [enabled, frame, minZoom, maxZoom, zoomStep, transformOrigin, scrollPansWhenZoomed]);

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    setPanning(true);
    setGrab({ x: e.clientX - state.offset.x, y: e.clientY - state.offset.y });
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!isPanning) return;
    setState((s) => ({ ...s, offset: { x: e.clientX - grab.x, y: e.clientY - grab.y } }));
  };
  const stopPanning = () => setPanning(false);

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      if (state.zoom <= minZoom) return;
      setPanning(true);
      setGrab({ x: e.touches[0].clientX - state.offset.x, y: e.touches[0].clientY - state.offset.y });
    } else if (e.touches.length === 2) {
      setPanning(false);
      const [a, b] = [e.touches[0], e.touches[1]];
      setState((s) => ({ ...s, pinch: { distance: touchDistance(a, b), midpoint: touchMidpoint(a, b) } }));
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 1 && isPanning) {
      e.preventDefault();
      const t = e.touches[0];
      setState((s) => ({ ...s, offset: { x: t.clientX - grab.x, y: t.clientY - grab.y } }));
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const rect = e.currentTarget.getBoundingClientRect();
      setState((s) => applyPinch(s, touchDistance(a, b), touchMidpoint(a, b), rect, transformOrigin, bounds));
    }
  };
  const onTouchEnd = () => {
    setPanning(false);
    setState((s) => ({ ...s, pinch: null }));
  };

  return {
    zoom: state.zoom,
    isPanning,
    style: panZoomTransform(state, transformOrigin),
    containerProps: {
      ref: setFrame,
      onMouseDown,
      onMouseMove,
      onMouseUp: stopPanning,
      onMouseLeave: stopPanning,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    zoomIn,
    zoomOut,
    zoomTo,
    resetView,
  };
}
