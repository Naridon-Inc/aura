// One answer to "close this when I click away or press Escape".
//
// Thirty files had written this effect out by hand — thirty-seven copies —
// and they disagreed on the part a person actually notices: sixteen of them
// never listened for Escape at all. Escape closed the brain picker, the tab
// menu and the window's own menus, but not the assignee picker, the task
// state pill, the task kebab, either plan menu, the reaction picker, the
// labels popover, the page-folder menu, the soundboard, the create-from
// picker or the project menu in the workspace composer — with nothing on
// screen to tell you which kind you were looking at.
//
// The rest of the disagreements were invisible but real: some listened on
// `window` and some on `document`, two forgot to guard on `open` and so kept
// a listener alive for a menu that wasn't there, the two portalled popovers
// had each discovered separately that a click inside the portal looks
// "outside" the trigger, and one file had already grown its own private
// version of this hook for the four dropdowns it happened to contain.
//
// Takes the ref you already have rather than handing one back — most callers
// need it for positioning too.

import { useEffect, useRef, type RefObject } from "react";

type AnyRef = RefObject<HTMLElement | null>;

export function useDismiss(
  /** Only listens while this is true — no menu, no listener. */
  open: boolean,
  /** Called on an outside mousedown or on Escape. Safe to pass an inline
   *  arrow: it's held in a ref, so a new identity each render doesn't tear
   *  the listeners down and put them back. */
  close: () => void,
  /** The element(s) that count as "inside". A portalled popover passes its
   *  own node here alongside the trigger, or it dismisses itself the moment
   *  you click into it. Pass `[]` for a pop that closes on any mousedown,
   *  including one on itself. */
  inside: AnyRef | AnyRef[],
  opts?: {
    /** Anything matching this CSS selector counts as inside too — for menus
     *  whose parts are marked with a data attribute rather than held in a
     *  ref. Accepts a selector list. */
    insideSelector?: string;
    /** Register the outside-click listener a tick late, so the very click
     *  that opened the menu doesn't also close it. Needed when the trigger
     *  opens on `mousedown` rather than `click`. */
    defer?: boolean;
    /** Also close on these window events — for a menu pinned to viewport
     *  coordinates that a resize invalidates, or one that shouldn't outlive
     *  the app losing focus. */
    closeOnWindow?: ReadonlyArray<"resize" | "blur">;
  },
) {
  const insideSelector = opts?.insideSelector;
  const defer = opts?.defer ?? false;
  // Joined so a fresh array literal each render doesn't re-run the effect.
  const windowEvents = (opts?.closeOnWindow ?? []).join(",");

  const closeRef = useRef(close);
  closeRef.current = close;

  // Callers pass either one ref or a fresh array literal of stable refs;
  // spreading them into the dep list keeps the effect keyed on the refs
  // themselves rather than on the array's identity.
  const refs = Array.isArray(inside) ? inside : [inside];

  useEffect(() => {
    if (!open) return;

    function isInside(target: EventTarget | null): boolean {
      const node = target instanceof Node ? target : null;
      if (!node) return false;
      for (const r of refs) {
        if (r.current?.contains(node)) return true;
      }
      if (insideSelector && node instanceof Element) {
        if (node.closest(insideSelector)) return true;
      }
      return false;
    }

    const fire = () => closeRef.current();
    function onDown(e: MouseEvent) {
      if (!isInside(e.target)) fire();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") fire();
    }

    let timer: number | undefined;
    if (defer) {
      timer = window.setTimeout(() => {
        document.addEventListener("mousedown", onDown);
      }, 0);
    } else {
      document.addEventListener("mousedown", onDown);
    }
    document.addEventListener("keydown", onKey);
    const winEvents = windowEvents ? windowEvents.split(",") : [];
    for (const ev of winEvents) window.addEventListener(ev, fire);

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      for (const ev of winEvents) window.removeEventListener(ev, fire);
    };
    // `refs` is spread so the effect keys on each ref object, not the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, insideSelector, defer, windowEvents, ...refs]);
}
