// The one place toasts are drawn. Subscribes to the store (`lib/toast.ts`) and
// stacks what it holds bottom-right: the newest in front, the two behind it
// peeking out above, anything past three waiting out of sight. Pointing at the
// stack — or tabbing into it, or pressing ⌥T — fans it out into a column and
// stops every timer until the pointer leaves. A toast leaves by its close
// button, its timer, one of its actions, or a swipe right/down.
//
// Mount once, near the root:  <Toaster />

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { announceOverlayChange } from "../lib/nativeSurfacePlacement";
import { toast, type Toast, type ToastAction } from "../lib/toast";
import {
  retime,
  settlePresence,
  spend,
  stackPaused,
  startClock,
  type StackPresence,
  type ToastClock,
} from "../lib/toastTimer";
import { ToastButton, ToastCloseButton, toastGlyph, toastKind } from "./ui/toast";

/** How many toasts show at once; the rest wait behind. */
const VISIBLE_TOASTS = 3;
/** How long a leaving toast stays in the tree for its exit motion. */
const EXIT_MS = 400;
/** How far a toast has to be dragged before letting go throws it away. */
const SWIPE_THRESHOLD = 40;

type SwipeDirection = "right" | "down";

type Entry = {
  toast: Toast;
  /** Gone from the store, playing its exit. */
  ending: boolean;
  /** Its place in the stack: 0 is the front. A leaving toast keeps the place it
   *  had so it exits from where it was. */
  index: number;
  swipe?: SwipeDirection;
};

/** Lay the store's toasts out newest-first and keep the ones that just left in
 *  their old slots until their exit has played. */
function reconcile(prev: Entry[], live: Toast[], swiped: Map<string, SwipeDirection>): Entry[] {
  const liveIds = new Set(live.map((t) => t.id));
  const next: Entry[] = live
    .slice()
    .reverse()
    .map((t) => ({ toast: t, ending: false, index: 0 }));
  prev.forEach((e, i) => {
    if (liveIds.has(e.toast.id)) return;
    const leaving: Entry = e.ending
      ? e
      : { ...e, ending: true, swipe: swiped.get(e.toast.id) };
    next.splice(Math.min(i, next.length), 0, leaving);
  });
  let index = 0;
  return next.map((e) => (e.ending ? e : { ...e, index: index++ }));
}

export function Toaster() {
  const live = useSyncExternalStore(toast.subscribe, toast.get, toast.get);
  const swiped = useRef(new Map<string, SwipeDirection>());
  const [entries, setEntries] = useState<Entry[]>(() => reconcile([], live, swiped.current));
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [hotkeyExpanded, setHotkeyExpanded] = useState(false);
  const [keyboardCollapsed, setKeyboardCollapsed] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const exitTimers = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    setEntries((prev) => reconcile(prev, live, swiped.current));
  }, [live]);

  // A leaving toast is dropped once its exit has played.
  useEffect(() => {
    for (const e of entries) {
      if (!e.ending || exitTimers.current.has(e.toast.id)) continue;
      const id = e.toast.id;
      exitTimers.current.set(
        id,
        window.setTimeout(() => {
          exitTimers.current.delete(id);
          swiped.current.delete(id);
          setEntries((prev) => prev.filter((x) => !(x.ending && x.toast.id === id)));
          setHeights(({ [id]: _gone, ...rest }) => rest);
        }, EXIT_MS),
      );
    }
  }, [entries]);
  useEffect(() => {
    const timers = exitTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  // Timers stop while the window is in the background.
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  // Focus has left the stack: fold it back and hand focus back to wherever ⌥T
  // took it from.
  const focusLeft = useCallback(() => {
    setFocusInside(false);
    setFocusVisible(false);
    setHotkeyExpanded(false);
    setKeyboardCollapsed(false);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back) queueMicrotask(() => back.focus({ preventScroll: true }));
  }, []);

  // A toast that goes takes the pointer's spot or the focus with it, and the
  // page sends no leave and no blur for an element it removed. Every toast is
  // focusable, so clicking one's close or action button puts focus in it: once
  // that toast was gone the stack still thought it was focused, every timer
  // after it waited for good, and its ring filled with nothing to close it.
  // So whenever the stack changes, ask the page where they really are.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const reported: StackPresence = { hovered, focusInside };
    const next = settlePresence(reported, {
      hovered: el.matches(":hover"),
      focusInside: el.contains(document.activeElement),
    });
    if (next === reported) return;
    if (!next.hovered) setHovered(false);
    if (!next.focusInside) focusLeft();
    // Only a change in the stack can take a toast out from under them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, focusLeft]);

  // And the pointer: a move that lands off the stack means it has left, leave
  // event or not (one never comes when the toast under it was removed).
  useEffect(() => {
    if (!hovered) return;
    const onMove = (e: MouseEvent) => {
      const el = viewportRef.current;
      if (el && !(e.target instanceof Node && el.contains(e.target))) setHovered(false);
    };
    document.addEventListener("mousemove", onMove, { capture: true, passive: true });
    return () => document.removeEventListener("mousemove", onMove, { capture: true });
  }, [hovered]);

  const hasToasts = entries.length > 0;

  // ⌥T moves focus into the stack and fans it out; Escape folds it back.
  useEffect(() => {
    if (!hasToasts) return;
    const onKey = (e: KeyboardEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      if (e.key === "Escape" && viewport.contains(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHotkeyExpanded(false);
        setKeyboardCollapsed(true);
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        if (!viewport.contains(document.activeElement)) {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        setHotkeyExpanded(true);
        setKeyboardCollapsed(false);
        viewport.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hasToasts]);

  const onHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  const onSwiped = useCallback((id: string, dir: SwipeDirection) => {
    swiped.current.set(id, dir);
    toast.close(id, "dismiss");
  }, []);

  const expanded = hovered || focusVisible;
  const paused = stackPaused({ hovered, focusInside, windowFocused });
  const showing = entries.filter((e) => !e.ending);
  const front = showing[0];
  const frontHeight = front ? heights[front.toast.id] : undefined;
  const frontExiting = entries[0]?.ending ?? false;

  // The terminal is a native surface the page cannot draw over, so it has to
  // step off the toasts itself (`nativeSurfacePlacement`). Each toast it must
  // avoid is marked below; this tells it when to look. Once now, for the
  // change, and once more when the motion it started has finished: a toast
  // measured on its way in or out is not where it will be.
  //
  // Keyed on the stack's shape, not its contents. A toast whose host re-sends
  // it on every render (`LiveToast`) is a new object each time, and a
  // terminal has nothing to re-read when only the words changed.
  const layout = entries
    .map((e) => `${e.toast.id}/${e.index}/${e.ending ? 1 : 0}/${heights[e.toast.id] ?? 0}`)
    .join("|");
  const fanned = expanded || hotkeyExpanded;
  useEffect(() => {
    announceOverlayChange();
    const settled = window.setTimeout(announceOverlayChange, EXIT_MS + 20);
    return () => window.clearTimeout(settled);
  }, [layout, fanned]);

  const offsetOf = (index: number) =>
    showing
      .filter((e) => e.index < index)
      .reduce((sum, e) => sum + (heights[e.toast.id] ?? 0), 0);

  return (
    <div
      ref={viewportRef}
      className="aura-toast-viewport"
      role="region"
      aria-label="Notifications alt+T"
      tabIndex={-1}
      data-y-position="bottom"
      data-x-position="right"
      data-expanded={hotkeyExpanded}
      data-keyboard-collapsed={keyboardCollapsed}
      data-front-exiting={frontExiting}
      // The close rings pause on this same answer, so a ring can't fill while
      // its timer is stopped (`toast.css`).
      data-paused={paused}
      style={
        frontHeight != null
          ? ({ "--toast-frontmost-height": `${frontHeight}px` } as CSSProperties)
          : undefined
      }
      onMouseEnter={() => {
        setKeyboardCollapsed(false);
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => {
        setFocusInside(true);
        if (e.target instanceof Element && e.target.matches(":focus-visible")) setFocusVisible(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focusLeft();
      }}
    >
      {entries.map((e, position) => (
        <ToastItem
          key={e.toast.id}
          entry={e}
          offsetY={offsetOf(e.index)}
          height={heights[e.toast.id]}
          expanded={expanded}
          front={!e.ending && e.index === 0}
          exitingFront={e.ending && position === 0}
          limited={!e.ending && e.index >= VISIBLE_TOASTS}
          paused={paused}
          onHeight={onHeight}
          onSwiped={onSwiped}
        />
      ))}
    </div>
  );
}

function ToastItem({
  entry,
  offsetY,
  height,
  expanded,
  front,
  exitingFront,
  limited,
  paused,
  onHeight,
  onSwiped,
}: {
  entry: Entry;
  offsetY: number;
  height: number | undefined;
  expanded: boolean;
  front: boolean;
  exitingFront: boolean;
  limited: boolean;
  paused: boolean;
  onHeight: (id: string, h: number) => void;
  onSwiped: (id: string, dir: SwipeDirection) => void;
}) {
  const t = entry.toast;
  const kind = toastKind(t.tone);
  const ref = useRef<HTMLDivElement>(null);
  const [starting, setStarting] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [movement, setMovement] = useState({ x: 0, y: 0 });
  const [swiping, setSwiping] = useState(false);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    axis: "x" | "y" | null;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // Enter from below: the first frame is drawn in the starting pose, the next
  // one lets the transition carry it in.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setStarting(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // Its natural height, measured with the stack's forced height lifted, so the
  // stack can fan out to the real sizes.
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || entry.ending) return;
    const inline = el.style.height;
    el.style.height = "auto";
    const h = el.offsetHeight;
    el.style.height = inline;
    onHeight(t.id, h);
  }, [entry.ending, onHeight, t.id]);
  useLayoutEffect(measure);
  useEffect(() => {
    const content = ref.current?.querySelector("[data-content]");
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(content);
    return () => ro.disconnect();
  }, [measure]);

  // The timer: counts down only while it can be seen and nobody is looking
  // at the stack. It starts over exactly when the ring does (`retime`): a new
  // duration, or the same id shown again as a new toast.
  const timing = useRef<ToastClock>(startClock(t.durationMs, t.createdAt));
  useEffect(() => {
    timing.current = retime(timing.current, t.durationMs, t.createdAt);
    if (t.durationMs == null || paused || entry.ending || limited) return;
    const clock = timing.current;
    const started = Date.now();
    const timer = window.setTimeout(() => toast.close(t.id, "auto"), clock.remaining);
    return () => {
      window.clearTimeout(timer);
      clock.remaining = spend(clock, Date.now() - started);
    };
  }, [t.id, t.durationMs, t.createdAt, paused, entry.ending, limited]);

  const closable = t.dismissible;
  const canSwipe = closable && !entry.ending;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canSwipe || e.button !== 0) return;
    if ((e.target as Element).closest("button, a, input, textarea, select, [role='switch']")) return;
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, axis: null };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.axis === null) {
      if (Math.hypot(dx, dy) < 5) return;
      // Dragging across the words selects them; that isn't a swipe.
      if (window.getSelection()?.toString()) {
        drag.current = null;
        return;
      }
      d.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      ref.current?.setPointerCapture(e.pointerId);
      setSwiping(true);
    }
    // Free toward the edges it can leave by; stiff the other way.
    const give = (v: number) => (v >= 0 ? v : -Math.sqrt(-v));
    setMovement(d.axis === "x" ? { x: give(dx), y: 0 } : { x: 0, y: give(dy) });
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.axis === null) return;
    setSwiping(false);
    const dist = d.axis === "x" ? e.clientX - d.x : e.clientY - d.y;
    if (!cancelled && dist > SWIPE_THRESHOLD) {
      onSwiped(t.id, d.axis === "x" ? "right" : "down");
    } else {
      setMovement({ x: 0, y: 0 });
    }
  };

  const run = async (a: ToastAction, i: number) => {
    setBusy(i);
    try {
      await a.onClick();
      if (!a.keepOpen) toast.close(t.id, "action");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const actions = t.actions ?? [];
  const icon = t.icon !== undefined ? t.icon : toastGlyph(kind);
  const timed = t.durationMs != null;

  const style = {
    "--toast-index": entry.index,
    "--toast-offset-y": `${offsetY}px`,
    "--toast-swipe-movement-x": `${movement.x}px`,
    "--toast-swipe-movement-y": `${movement.y}px`,
    ...(height != null ? { "--toast-height": `${height}px` } : {}),
    ...(timed ? { "--aura-toast-progress-duration": `${t.durationMs}ms` } : {}),
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={timed ? "aura-toast aura-timed-toast" : "aura-toast"}
      role={kind === "error" ? "alert" : "status"}
      aria-atomic="true"
      tabIndex={0}
      data-styled="true"
      data-type={kind}
      data-front={front}
      data-exiting-front={exitingFront}
      data-dismissible={closable}
      data-expanded={expanded ? "" : undefined}
      data-limited={limited ? "" : undefined}
      // A native terminal under the stack steps off every toast that paints
      // (a leaving one too, until it is gone), keeping its left edge and
      // hiding only the rows or columns the toast is on. A toast waiting past
      // the third is invisible and must not cost the terminal anything.
      data-over-native-surface={limited ? undefined : ""}
      data-starting-style={starting ? "" : undefined}
      data-ending-style={entry.ending ? "" : undefined}
      data-swipe-direction={entry.ending ? entry.swipe : undefined}
      data-swiping={swiping ? "" : undefined}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onKeyDownCapture={(e) => {
        // Escape belongs to the stack; it never reaches a dialog underneath.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {closable && (
        <ToastCloseButton
          key={t.durationMs == null ? "sticky" : `${t.durationMs}/${t.createdAt}`}
          label={t.dismissLabel}
          onClick={() => toast.close(t.id, "dismiss")}
        />
      )}
      {icon != null && <div data-icon="">{icon}</div>}
      <div
        data-content=""
        data-behind={front ? undefined : ""}
        data-expanded={expanded ? "" : undefined}
      >
        {t.title != null && <div data-title="">{t.title}</div>}
        {t.message != null && <div data-description="">{t.message}</div>}
      </div>
      {t.actionRow != null
        ? t.actionRow
        : actions.map((a, i) => (
            <ToastButton
              key={`${i}-${a.label}`}
              primary={a.variant === "primary" || (actions.length === 1 && a.variant !== "default")}
              busy={busy === i}
              disabled={busy !== null}
              onClick={() => void run(a, i)}
            >
              {a.label}
            </ToastButton>
          ))}
    </div>
  );
}
