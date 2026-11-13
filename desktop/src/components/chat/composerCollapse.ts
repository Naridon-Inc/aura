//! When the composer is a strip and when it is a box.
//!
//! The collapse is not a size the pane picks — it is a reading of what the
//! user is doing, and it fits in one line: a composer
//! minimizes when a CONTENT surface is what you are looking at *and* there is
//! nothing in the composer worth keeping open for. Both halves matter. Over a
//! terminal with a half-typed prompt in the box it stays open, because
//! collapsing would hide work. On the conversation itself it stays open
//! whatever the draft says, because there the composer is the subject rather
//! than an overlay.
//!
//! It is deliberately NOT a blur rule. A composer that folds the moment focus
//! leaves folds when you click the transcript to read what you are answering,
//! which is the one gesture that must not move the thing you are typing into.
//!
//! The policy is a pure function so it can be read and tested without a DOM,
//! and so the five inputs are named in one place rather than inferred from
//! wherever the attribute happens to be set.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/** How long an interaction keeps the composer open after the draft empties.
 *
 *  It is a forgiveness window rather than an
 *  animation delay: sending a message empties the draft, and a composer that
 *  collapsed on that frame would fold under the cursor of someone about to
 *  type a second line. Half a second is long enough to keep typing through
 *  and short enough that a composer you walked away from is gone by the time
 *  you look back. */
export const COMPOSER_MINIMIZE_DELAY_MS = 500;

export type ComposerCollapseInputs = {
  /** The pane is showing a content surface — a terminal, a file, a diff —
   *  rather than the conversation, so the composer is an overlay on it and
   *  the room it takes is room taken from something being read. */
  overlaying: boolean;
  /** Nothing typed, nothing attached. */
  empty: boolean;
  /** Focus is somewhere inside the composer. */
  focused: boolean;
  /** Something is waiting on the user — a question, a permission request, a
   *  queued approval. These fold in with the draft under one
   *  name (`canMinimize`), and it is the same reason: the composer is the only
   *  place the answer can be given, so it cannot be the thing that hides. */
  blocked: boolean;
  /** The user has touched the composer and the forgiveness window above has
   *  not yet run out. */
  engaged: boolean;
};

/** Is the composer a strip right now?
 *
 *  Reads as `isViewingContentTab && canMinimize`, with
 *  `canMinimize` spelled out into the three things it actually means. */
export function isComposerMinimized(input: ComposerCollapseInputs): boolean {
  if (!input.overlaying) return false;
  return input.empty && !input.focused && !input.blocked && !input.engaged;
}

/** What a press on the strip leaves to the control it landed on. A button or a
 *  menu trigger in the strip (the model icon, send) is pinned to the box's
 *  bottom edge, so it is still under the pointer once the box has grown and
 *  its own click goes through. Everything else in the strip means "let me
 *  type", and that is the field's to take. */
export const STRIP_CONTROL_SELECTOR =
  'button, a[href], input, select, [role="button"], [role="combobox"], [role="menuitem"]';

/** Does this press put focus in the field itself, rather than leaving it to
 *  the browser? Only on the strip, only for the primary button, and never
 *  for a control: the open box keeps the browser's own caret placement, and a
 *  right-click or a press on the model icon goes where it was aimed. */
export function pressTakesField(press: {
  minimized: boolean;
  button: number;
  onControl: boolean;
}): boolean {
  return press.minimized && press.button === 0 && !press.onControl;
}

/** The parts of a pointer press the strip reads. */
type StripPress = {
  currentTarget: Element;
  target: EventTarget | null;
  button: number;
};

export type ComposerCollapse = {
  /** Handed to the shared box as `minimized`. */
  minimized: boolean;
  /** Handed to the shared box as `animateResize`: true when the last fold or
   *  unfold came from the user (a click, focus, the forgiveness window
   *  running out), false when it came from a change of surface, which lands
   *  on the new state at once. */
  animate: boolean;
  /** Spread onto the frame. Any pointer or focus inside it opens the
   *  composer; focus leaving starts the forgiveness window. */
  handlers: {
    onPointerDownCapture: (event: StripPress) => void;
    onMouseDownCapture: (event: { preventDefault: () => void }) => void;
    onFocusCapture: () => void;
    onBlurCapture: (event: { currentTarget: Node; relatedTarget: EventTarget | null }) => void;
  };
};

/** The collapse, as state. See [`isComposerMinimized`] for the rule it
 *  applies and `COMPOSER_MINIMIZE_DELAY_MS` for the one timer involved. */
export function useComposerCollapse({
  overlaying,
  empty,
  blocked = false,
  field,
}: {
  overlaying: boolean;
  empty: boolean;
  blocked?: boolean;
  /** The message field. A press on the strip puts focus here itself; see
   *  `onPointerDownCapture` below for why the browser cannot be left to. */
  field: RefObject<HTMLTextAreaElement | null>;
}): ComposerCollapse {
  const [focused, setFocused] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [surface, setSurface] = useState(overlaying);

  // A change of surface resets the composer to whatever the new surface
  // implies: flipping to the terminal is a different view, not a composer
  // gesture, so an open box from the conversation does not stay open over it.
  // It is settled during this render, before anything is drawn, so the box
  // lands on the new state at once instead of easing to it a frame late.
  if (surface !== overlaying) {
    setSurface(overlaying);
    setEngaged(false);
    setAnimate(false);
  }

  // The forgiveness window. Runs only while the composer is open on nothing:
  // a draft being typed, focus still inside, or a question waiting all hold
  // it open with no timer running at all.
  useEffect(() => {
    if (!engaged || !empty || focused || blocked) return;
    const timer = setTimeout(() => {
      setAnimate(true);
      setEngaged(false);
    }, COMPOSER_MINIMIZE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [engaged, empty, focused, blocked]);

  // Read by the press handlers, which run between renders.
  const minimizedRef = useRef(false);
  // Set by a press that has already put focus in the field, and spent by the
  // mousedown of the same press.
  const focusTaken = useRef(false);

  // The strip is clickable, so a press on it opens the box. The box grows
  // upward from its bottom edge, and React commits that growth before the
  // browser runs the press's default focus. By then the field has moved up and
  // the point that was over it is over the footer row, which cannot take
  // focus. Focus goes to the nearest ancestor that can, which is the
  // transcript section, the composer reads that as focus leaving, and the
  // forgiveness window folds the box half a second after it opened.
  //
  // So a press on the strip that is not aimed at one of its controls gives
  // focus to the field directly, while the press is still being dispatched,
  // and the mousedown that follows is told not to move it. The field is empty
  // whenever the strip shows, so there is no caret position to lose.
  const onPointerDownCapture = useCallback(
    (event: StripPress) => {
      focusTaken.current = false;
      setAnimate(true);
      setEngaged(true);
      const target = event.target;
      const onControl = target instanceof Element && target.closest(STRIP_CONTROL_SELECTOR) != null;
      if (!pressTakesField({ minimized: minimizedRef.current, button: event.button, onControl })) return;
      const el = field.current;
      if (!el || !event.currentTarget.contains(el)) return;
      el.focus({ preventScroll: true });
      focusTaken.current = document.activeElement === el;
    },
    [field],
  );
  const onMouseDownCapture = useCallback((event: { preventDefault: () => void }) => {
    if (!focusTaken.current) return;
    focusTaken.current = false;
    event.preventDefault();
  }, []);
  const onFocusCapture = useCallback(() => {
    setAnimate(true);
    setFocused(true);
    setEngaged(true);
  }, []);
  // React's blur is `focusout`, which fires on every hop between the editor
  // and the toolbar. `relatedTarget` is where focus actually went, so a hop
  // inside the composer is not focus leaving it.
  const onBlurCapture = useCallback(
    (event: { currentTarget: Node; relatedTarget: EventTarget | null }) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setFocused(false);
    },
    [],
  );

  const minimized = isComposerMinimized({ overlaying, empty, focused, blocked, engaged });
  useLayoutEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  // Capture phase, so the strip has opened and focus is in the field before
  // anything inside the composer sees the press.
  const handlers = useMemo(
    () => ({ onPointerDownCapture, onMouseDownCapture, onFocusCapture, onBlurCapture }),
    [onPointerDownCapture, onMouseDownCapture, onFocusCapture, onBlurCapture],
  );

  return { minimized, animate, handlers };
}
