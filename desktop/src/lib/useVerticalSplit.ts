import { useCallback, useEffect, useRef, useState } from "react";

/** A persisted top/bottom split ratio with a draggable divider.
 *
 *  `ratio` is the TOP pane's share of the container height, clamped to
 *  [MIN, MAX] so neither pane collapses. Wire it up as:
 *    - `containerRef` on the flex-col wrapper,
 *    - `flexGrow: ratio` / `flexGrow: 1 - ratio` (with `minHeight: 0`) on the
 *      two panes,
 *    - `onPointerDown` on a thin divider between them.
 *  The chosen ratio is written to `localStorage` on release so the split
 *  survives reloads. Pointer-based (not mouse) so it works with trackpads and
 *  pens; listeners bind once for the life of the hook. */
export function useVerticalSplit(storageKey: string, initial = 0.5) {
  const MIN = 0.15;
  const MAX = 0.85;
  const [ratio, setRatio] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(storageKey));
      return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : initial;
    } catch {
      return initial;
    }
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  // Latest ratio for the pointerup persist without re-binding listeners.
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
  }, []);

  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const r = (e.clientY - rect.top) / rect.height;
      setRatio(Math.min(MAX, Math.max(MIN, r)));
    }
    function up() {
      if (!dragging.current) return;
      dragging.current = false;
      try {
        localStorage.setItem(storageKey, String(ratioRef.current));
      } catch {
        /* localStorage full/disabled — the in-memory ratio still holds */
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [storageKey]);

  return { ratio, containerRef, onPointerDown };
}
