// Feature Map — pan and zoom.
//
// One transform (`tx`, `ty`, `s`) applied to a single SVG group. Scroll
// pans, ⌘/ctrl-scroll zooms around the cursor, dragging the background
// pans, and `fit` / `centerOn` move the camera on the map's behalf when a
// flow opens somewhere off screen. The wheel listener is attached by hand
// so it can be non-passive — React's synthetic onWheel cannot call
// preventDefault, and without it the whole pane scrolls instead.

import { useCallback, useEffect, useRef, useState } from "react";
import { fitScale } from "./layout";

export type View = { tx: number; ty: number; s: number };

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
/** Pointer travel (px) below which a press counts as a click, not a drag. */
export const CLICK_SLOP = 4;

export function useViewport(
  host: React.RefObject<HTMLDivElement | null>,
) {
  const [view, setView] = useState<View>({ tx: 0, ty: 0, s: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);

  const size = useCallback(() => {
    const el = host.current;
    return el ? { vw: el.clientWidth, vh: el.clientHeight } : { vw: 0, vh: 0 };
  }, [host]);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.s * factor));
      if (s === v.s) return v;
      const { vw, vh } = size();
      const px = cx ?? vw / 2;
      const py = cy ?? vh / 2;
      const k = s / v.s;
      return { s, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
    });
  }, [size]);

  const fit = useCallback((W: number, H: number) => {
    const { vw, vh } = size();
    if (!vw || !vh) return;
    const s = fitScale(W, H, vw, vh);
    setView({ s, tx: (vw - W * s) / 2, ty: Math.max(16, (vh - H * s) / 2) });
  }, [size]);

  /** Bring a canvas rectangle into view, zooming only if it does not fit. */
  const centerOn = useCallback((x: number, y: number, w: number, h: number) => {
    const { vw, vh } = size();
    if (!vw || !vh) return;
    setView((v) => {
      const s = Math.min(v.s, fitScale(w, h, vw, vh) < v.s ? fitScale(w, h, vw, vh) : v.s);
      const sx = x * s + v.tx;
      const sy = y * s + v.ty;
      const inside =
        s === v.s && sx >= 16 && sy >= 16 && sx + w * s <= vw - 16 && sy + h * s <= vh - 16;
      if (inside) return v;
      return { s, tx: (vw - w * s) / 2 - x * s, ty: Math.max(16, (vh - h * s) / 2) - y * s };
    });
  }, [size]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [host, zoomBy]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const v = viewRef.current;
    drag.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  }, []);

  /** Returns true when the press was a drag (so click handlers skip). */
  const onPointerUp = useCallback((e: React.PointerEvent): boolean => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (d?.moved) setDragging(false);
    return Boolean(d?.moved);
  }, []);

  /** Was the last press a drag? Read this inside onClick handlers. */
  const wasDrag = useCallback(() => Boolean(drag.current?.moved), []);

  return {
    view,
    dragging,
    zoomBy,
    fit,
    centerOn,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    wasDrag,
  };
}
