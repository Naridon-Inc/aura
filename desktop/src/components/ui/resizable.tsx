// One resizable pane, for every pane in the app.
//
// A pane is not a width. It is a width you can drag, that clamps to bounds it
// can state, that survives a reload, and that gives way when the window is too
// small to hold it. The app had that — three times, written three ways:
//
//   Layout.tsx        the sidebar, the review rail (Changes / Checks) and the
//                     bottom pane. `useStored` + `DragHandle`, mouse events on
//                     `window`, one shared drag ref for all three.
//   TeamSurface.tsx   the context column. `usePersistentWidth` +
//                     `ColumnResizer`, pointer events, self-contained.
//   PlacePage.tsx     the place rail — Pages' documents, Team's conversations,
//                     Tasks' buckets. A `const`. 220px, always, for everyone.
//
// The third is the bug the other two explain: a second sidebar that carries a
// project picker, groups and rows, sitting at exactly one width because it was
// the only rail nobody had written the drag for yet. Which is the whole
// argument for this file — three copies of a mechanism means the surface that
// forgets to copy it is simply worse, and nothing tells you.
//
// So the mechanism lives here and the panes take it. `PaneResizer` is the
// grabbable hairline, `usePaneSize` is the width that remembers, and
// `ResizablePane` is the two of them in the right order for the edge you're on.
//
// Pointer events, not mouse: they cover trackpad, pen and touch in one path,
// and each drag owns the listeners it adds, so a pane can mount and unmount
// mid-layout without leaving a live handler behind. That was Team's version;
// it is the better of the two, so it is the one that survived.

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Which window edge the pane is pinned to. A leading pane grows when you drag
 *  right; a trailing one grows when you drag left. Getting this backwards is
 *  the classic resizer bug, so the caller names the edge and the arithmetic is
 *  derived from it rather than re-guessed at each site. */
export type PaneEdge = "leading" | "trailing";

/** A size that remembers itself. localStorage-backed and clamped on both the
 *  read and the write, so a stored value from an older build (or a hand-edited
 *  one) can never put a pane outside the bounds this build allows.
 *
 *  Storage is best-effort: private mode and quota errors fall through to the
 *  default rather than taking the surface down with them. */
export function usePaneSize(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
) {
  const [size, setSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw == null ? NaN : parseFloat(raw);
      if (Number.isFinite(n)) return clampSize(n, min, max);
    } catch {
      /* private mode / quota — fall through to the default */
    }
    return initial;
  });

  const set = useCallback(
    (next: number) => {
      const clamped = clampSize(next, min, max);
      setSize(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* persistence is best-effort */
      }
    },
    [storageKey, min, max],
  );

  return [size, set] as const;
}

/** The draggable boundary between two panes.
 *
 *  4px wide with -2px margins on both sides: a ~6px catch area that consumes
 *  no layout width, so the panes either side stay flush against the 1px border
 *  they share and resizing moves the divider without shifting a pixel of
 *  anything else. */
export function PaneResizer({
  orientation,
  edge = "leading",
  size,
  min,
  max,
  onResize,
  label,
}: {
  /** `vertical` separates columns (drag left/right); `horizontal` separates
   *  rows (drag up/down). Named for the separator, as ARIA names it. */
  orientation: "vertical" | "horizontal";
  /** Which side of the handle the pane being sized is on. `leading` = the pane
   *  is before the handle (a left sidebar, a top row); `trailing` = after it
   *  (a right rail, a bottom pane). */
  edge?: PaneEdge;
  /** The pane's size right now — the drag is relative to it, so a resize that
   *  starts mid-layout doesn't jump. */
  size: number;
  min: number;
  max: number;
  onResize: (next: number) => void;
  /** What this divider sizes, for screen readers. */
  label?: string;
}) {
  const vertical = orientation === "vertical";

  // The live drag reads `size` at press time and then works from its own
  // captured start values, so re-renders during the drag can't retarget it.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const start = vertical ? e.clientX : e.clientY;
    const startSize = size;
    const cursor = vertical ? "col-resize" : "row-resize";

    const move = (ev: PointerEvent) => {
      const delta = (vertical ? ev.clientX : ev.clientY) - start;
      // A trailing pane's near edge moves opposite to its size: dragging the
      // divider left makes a right-hand rail wider.
      onResize(clampSize(edge === "leading" ? startSize + delta : startSize - delta, min, max));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = cursor;
    // Without this a drag across a pane full of rows selects every label it
    // crosses, and you finish the resize looking at a blue page.
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Keyboard: a divider you can only drag is a divider a keyboard user cannot
  // move at all. Arrow keys nudge, Home/End take it to its bounds — the
  // separator role's own convention.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const fwd = vertical ? "ArrowRight" : "ArrowDown";
    const step = e.shiftKey ? 40 : 8;
    let next: number | null = null;
    if (e.key === back) next = edge === "leading" ? size - step : size + step;
    else if (e.key === fwd) next = edge === "leading" ? size + step : size - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next == null) return;
    e.preventDefault();
    onResize(clampSize(next, min, max));
  };

  const style: CSSProperties = vertical
    ? { width: 4, marginLeft: -2, marginRight: -2, background: "transparent", flexShrink: 0, zIndex: 5 }
    : { height: 4, marginTop: -2, marginBottom: -2, background: "transparent", flexShrink: 0, zIndex: 5 };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={
        vertical
          ? "cursor-col-resize hover:bg-line focus-visible:bg-accent focus-visible:outline-none"
          : "cursor-row-resize hover:bg-line focus-visible:bg-accent focus-visible:outline-none"
      }
      style={style}
    />
  );
}

/** A pane and the divider that sizes it, in the right order for its edge.
 *
 *  Renders as a fragment, so it drops straight into the caller's flex row (or
 *  column) as two siblings rather than wrapping the layout in another box —
 *  which is what lets the divider sit ON the boundary the two panes already
 *  share instead of next to it.
 *
 *  `max` may change with the window: pass a bound computed from the container
 *  and the pane shrinks to fit rather than crowding the body out. The stored
 *  size is left alone, so widening the window gives back the width you chose. */
export function ResizablePane({
  orientation = "vertical",
  edge = "trailing",
  size,
  min,
  max,
  onResize,
  label,
  className,
  style,
  children,
}: {
  orientation?: "vertical" | "horizontal";
  edge?: PaneEdge;
  size: number;
  min: number;
  max: number;
  onResize: (next: number) => void;
  label?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const vertical = orientation === "vertical";
  const shown = clampSize(size, min, max);

  const resizer = (
    <PaneResizer
      orientation={orientation}
      edge={edge}
      size={shown}
      min={min}
      max={max}
      onResize={onResize}
      label={label}
    />
  );
  const pane = (
    <div
      className={className}
      style={{
        ...(vertical ? { width: shown } : { height: shown }),
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );

  return edge === "leading" ? (
    <>
      {pane}
      {resizer}
    </>
  ) : (
    <>
      {resizer}
      {pane}
    </>
  );
}

/** Live width of an element. Panes bound their max against the box they're in
 *  rather than against the window, because a place mounted in a workpane has a
 *  container much narrower than the screen and a rail that ignored that would
 *  leave the body a sliver. */
export function useMeasuredWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  fallback = 0,
): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setW(entry.contentRect.width);
    });
    observer.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref]);
  return w;
}

/** Bound a pane's max against the box it lives in, so the body it sits beside
 *  always keeps `bodyMin` to work in. Returns `max` untouched until the
 *  container is actually measured (0 on the first paint), because clamping
 *  against a width nobody has measured yet collapses the pane for one frame. */
export function fitMax(containerW: number, bodyMin: number, min: number, max: number): number {
  if (containerW <= 0) return max;
  return Math.max(min, Math.min(max, containerW - bodyMin));
}
