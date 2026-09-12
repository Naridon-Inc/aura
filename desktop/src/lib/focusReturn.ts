// Where the keyboard goes when a focus surface closes.
//
// Opening a wizard (FullscreenOverlay) moves the reader into a surface that owns
// the whole window. Closing it used to leave focus on <body>, so a keyboard user
// who pressed Enter on a session row and then Esc was returned to the top of the
// document — they had to tab back through the entire list to reach the row they
// had just been on. The mouse hides this completely, which is why it survived.
//
// The convention every dialog library follows is: remember what had focus when
// the surface opened, and give it back on close. That is all this is, minus the
// DOM, so it can be reasoned about and tested without a renderer.

/** The part of an element this module needs. Kept structural so a test can pass
 *  a plain object and so a non-element `activeElement` can't break the call. */
export type Focusable = {
  /** False once the element has left the document — a row that was filtered
   *  away, a pane that was closed. Focusing one of those does nothing useful
   *  and, in some browsers, scrolls the page to a detached position. */
  isConnected: boolean;
  focus: (options?: { preventScroll?: boolean }) => void;
};

/** True when this is something worth handing focus back to. `body` is the
 *  fallback the browser parks focus on when nothing else holds it — returning
 *  to it is the same as returning nowhere, so it is not remembered. */
export function isWorthReturningTo(
  el: unknown,
  body?: unknown,
): el is Focusable {
  if (!el || typeof el !== "object") return false;
  if (body !== undefined && el === body) return false;
  const cand = el as Partial<Focusable>;
  return typeof cand.focus === "function" && typeof cand.isConnected === "boolean";
}

/** Remember what has focus now, and hand back the function that restores it.
 *
 *  The returned function is safe to call any number of times and at any point
 *  in a teardown: it does nothing when there was nothing worth remembering, and
 *  nothing when the remembered element has since left the document. */
export function captureFocus(active: unknown, body?: unknown): () => void {
  if (!isWorthReturningTo(active, body)) return () => {};
  const target = active;
  return () => {
    if (!target.isConnected) return;
    // `preventScroll` because the point is to restore the keyboard, not to
    // yank the viewport: the surface underneath is already scrolled where the
    // reader left it, and re-focusing a row must not jump it.
    target.focus({ preventScroll: true });
  };
}
