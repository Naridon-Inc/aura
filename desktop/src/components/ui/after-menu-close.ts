// A menu item that opens something which takes focus (a popover, a dialog, a
// name field in place) has to wait for its menu to be gone. A closing menu
// hands focus back to the button that opened it, after its exit animation, so
// it lands after any guessed delay: a popover opened before then reads that
// as a click elsewhere and shuts, and a field or dialog is left without focus.
//
// So the item only records what it wants, and the menu runs it from
// `onCloseAutoFocus`, in place of that focus return, on the next frame. An item
// that records nothing leaves the menu to hand focus back as usual.

import { useRef } from "react";

export type AfterMenuClose = {
  /** Record `action` to run once the menu has closed; call it from an item's
   *  `onSelect`. */
  defer: (action: () => void) => void;
  /** An item's `onSelect` that defers `action`, or none when there is none. */
  later: (action?: () => void) => (() => void) | undefined;
  /** Give this to the menu content's `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void;
};

/** One menu's deferral; `schedule` stands in for the next frame in tests. */
export function afterMenuClose(
  schedule: (run: () => void) => void = (run) => {
    requestAnimationFrame(run);
  },
): AfterMenuClose {
  let pending: (() => void) | undefined;
  const defer = (action: () => void) => {
    pending = action;
  };
  return {
    defer,
    later: (action) => (action ? () => defer(action) : undefined),
    onCloseAutoFocus: (event) => {
      const action = pending;
      if (!action) return;
      pending = undefined;
      event.preventDefault();
      schedule(action);
    },
  };
}

/** `afterMenuClose` kept for the life of the component that draws the menu. */
export function useAfterMenuClose(): AfterMenuClose {
  const held = useRef<AfterMenuClose | null>(null);
  held.current ??= afterMenuClose();
  return held.current;
}
