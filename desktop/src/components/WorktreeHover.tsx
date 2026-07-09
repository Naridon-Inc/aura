// Hover bridge for a worktree row. Replaces the Medusa `Tooltip` the roster
// used to wrap each copy: a tooltip is a portal you can only LOOK at — the
// moment the card grew real buttons (Commit & push, Create PR…) a tooltip
// stopped being viable, because the cursor can't travel from the row into a
// tooltip without it vanishing. This is the same hand-rolled hover pattern the
// workspace-tile popover uses (enter/leave timers + a live "keep it open while
// I'm over the card" bridge), rendered through a `document.body` portal with
// fixed positioning so it floats OVER the main pane instead of being clipped
// by the sidebar's own overflow — exactly how Conductor's copy card behaves.
//
// The card only mounts while it's open, so its own data fetch (git ahead/
// behind) runs on hover, not for every row in the list.

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY = 240;
const CLOSE_DELAY = 160;
const GAP = 8;
const EDGE = 12;

type Props = {
  /** The card body to float beside the row (mounted only while open). */
  card: ReactNode;
  /** The row element. Must be a single host element (a div) — the bridge
   *  clones a ref + hover handlers onto it, so it needs a real DOM box. */
  children: ReactElement;
  /** Suppress the card (e.g. while a context menu is open on the row). */
  disabled?: boolean;
};

export function WorktreeHover({ card, children, disabled }: Props) {
  const rowRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const enterT = useRef<number | null>(null);
  const leaveT = useRef<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [measured, setMeasured] = useState(false);

  const cancelEnter = () => {
    if (enterT.current) {
      window.clearTimeout(enterT.current);
      enterT.current = null;
    }
  };
  const cancelLeave = useCallback(() => {
    if (leaveT.current) {
      window.clearTimeout(leaveT.current);
      leaveT.current = null;
    }
  }, []);

  const open = useCallback(() => {
    if (disabled) return;
    cancelLeave();
    if (rect || enterT.current) return;
    enterT.current = window.setTimeout(() => {
      enterT.current = null;
      const r = rowRef.current?.getBoundingClientRect();
      if (r) {
        setMeasured(false);
        setRect(r);
        setPos({ left: r.right + GAP, top: r.top });
      }
    }, OPEN_DELAY);
  }, [disabled, rect, cancelLeave]);

  const close = useCallback(() => {
    cancelEnter();
    if (leaveT.current) return;
    leaveT.current = window.setTimeout(() => {
      leaveT.current = null;
      setRect(null);
      setPos(null);
      setMeasured(false);
    }, CLOSE_DELAY);
  }, []);

  // Clamp the card inside the viewport once it has a measured size — flip to
  // the row's left if it would run off the right edge, lift it up if it would
  // run off the bottom. Runs once per open (keyed on the captured rect).
  useLayoutEffect(() => {
    if (!rect) return;
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 180;
    let left = rect.right + GAP;
    if (left + w > window.innerWidth - EDGE) {
      left = Math.max(EDGE, rect.left - GAP - w);
    }
    let top = rect.top;
    if (top + h > window.innerHeight - EDGE) {
      top = Math.max(EDGE, window.innerHeight - EDGE - h);
    }
    setPos({ left, top });
    setMeasured(true);
  }, [rect]);

  useEffect(
    () => () => {
      cancelEnter();
      cancelLeave();
    },
    [cancelLeave],
  );

  if (!isValidElement(children)) return children;

  const row = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      rowRef.current = node;
    },
    onMouseEnter: open,
    onMouseLeave: close,
  });

  return (
    <>
      {row}
      {pos &&
        createPortal(
          <div
            ref={cardRef}
            className="wt-hc-pop"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              zIndex: 60,
              visibility: measured ? "visible" : "hidden",
            }}
            onMouseEnter={cancelLeave}
            onMouseLeave={close}
          >
            {card}
          </div>,
          document.body,
        )}
    </>
  );
}
