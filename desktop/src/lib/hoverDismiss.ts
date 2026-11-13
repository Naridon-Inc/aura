// A hover card closes when the pointer leaves its row or the card, and on a
// click outside. Nothing else moves it. So when the row stops being on screen
// with the pointer still — the page changes under it, the list scrolls it
// away, it is hidden, the app loses focus — the card stays up, pinned where
// its row used to be, over whatever page is showing now.
//
// This is the rest of the rule: while a card is open, watch for its row going
// away and close the card when it does. Pure over what it is given, so it can
// be exercised without a DOM.

/** The window a row is looked for in. */
export type HoverView = {
  width: number;
  height: number;
  elementFromPoint: (x: number, y: number) => Element | null;
};

/** The parts of a row element this needs. */
export type HoverRow = Pick<Element, "getBoundingClientRect" | "contains"> & {
  isConnected: boolean;
};

/**
 * Whether the row a card belongs to can still be seen: in the document, laid
 * out, inside the window, and not covered by something else at its centre —
 * which is what a page drawn over it, or a list scrolled past it, looks like.
 */
export function rowShowing(row: HoverRow | null, view: HoverView): boolean {
  if (!row || !row.isConnected) return false;
  const r = row.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) return false;
  const hit = view.elementFromPoint(x, y);
  return !!hit && row.contains(hit);
}

export type HoverDismissWatch = {
  /** Close the card. Called at most once. */
  close: () => void;
  /** Whether the card's row can still be seen. */
  isShowing: () => boolean;
  /** Whether a scroll came from inside the card, which is the card's own. */
  inCard: (target: EventTarget | null) => boolean;
  /** Scroll (any element's, caught on the way down), blur, history moves. */
  win: EventTarget;
  /** Visibility: a hidden window has no row to point at. */
  doc: EventTarget & { visibilityState?: string };
  /** Run `check` on a beat until the returned cancel is called. */
  every: (check: () => void) => () => void;
};

/**
 * Watch an open card's row and close the card the moment the row is gone.
 * Returns the cleanup — run it when the card closes or its row unmounts.
 */
export function watchHoverDismiss(w: HoverDismissWatch): () => void {
  let stopped = false;
  const onScroll = (e: Event) => {
    if (!w.inCard(e.target)) dismiss();
  };
  const onVisibility = () => {
    if (w.doc.visibilityState === "hidden") dismiss();
  };
  const cancelBeat = w.every(() => {
    if (!w.isShowing()) dismiss();
  });
  w.win.addEventListener("scroll", onScroll, true);
  w.win.addEventListener("blur", dismiss);
  w.win.addEventListener("popstate", dismiss);
  w.win.addEventListener("hashchange", dismiss);
  w.doc.addEventListener("visibilitychange", onVisibility);

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelBeat();
    w.win.removeEventListener("scroll", onScroll, true);
    w.win.removeEventListener("blur", dismiss);
    w.win.removeEventListener("popstate", dismiss);
    w.win.removeEventListener("hashchange", dismiss);
    w.doc.removeEventListener("visibilitychange", onVisibility);
  }
  function dismiss() {
    if (stopped) return;
    stop();
    w.close();
  }
  return stop;
}
