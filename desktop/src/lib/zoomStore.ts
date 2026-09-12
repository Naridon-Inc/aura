// The app's zoom level, as one store the keyboard and the Settings pane share.
//
// ⌘+ / ⌘− in App.tsx used to hold the level in a `useState` nobody else could
// reach, so a Settings slider would have been a second copy of the number that
// drifted from the first on the first keypress. This module owns the number;
// App.tsx applies it to the webview and to CSS exactly as before, and the
// Appearance pane reads and writes the same one.
//
// Persisted under `aura.zoom` (the key App.tsx always used, so an existing
// choice survives the move). 50%–200% is what every browser allows.

import { useEffect, useState } from "react";

export const ZOOM_KEY = "aura.zoom";
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
}

/** Read the persisted zoom without touching React state. */
export function storedZoom(): number {
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem(ZOOM_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) ? clampZoom(n) : 1;
  } catch {
    return 1;
  }
}

let level = storedZoom();
const subs = new Set<() => void>();

export function getZoom(): number {
  return level;
}

/** Set the level, or update it from the current one — the same shape as a
 *  React state setter, so the keyboard handlers in App.tsx read unchanged. */
export function setZoom(next: number | ((z: number) => number)): void {
  const value = clampZoom(typeof next === "function" ? next(level) : next);
  if (value === level) return;
  level = value;
  subs.forEach((fn) => fn());
}

export function zoomIn(): void {
  setZoom((z) => z + ZOOM_STEP);
}

export function zoomOut(): void {
  setZoom((z) => z - ZOOM_STEP);
}

export function resetZoom(): void {
  setZoom(1);
}

/** The level as a whole percent, for a label. */
export function zoomPercent(z: number): number {
  return Math.round(z * 100);
}

/** `[zoom, setZoom]` — the tuple App.tsx's `useState` used to return. */
export function useZoomLevel(): [number, typeof setZoom] {
  const [z, setLocal] = useState<number>(level);
  useEffect(() => {
    const fn = () => setLocal(level);
    subs.add(fn);
    fn();
    return () => {
      subs.delete(fn);
    };
  }, []);
  return [z, setZoom];
}
