// traceNav — the seam that lets any surface say "open the Trace session detail
// for this run". A session deep link uses it: `aura://session/…` arrives from
// the website, a teammate's message or the phone, App resolves it to a run, and
// this carries that row the rest of the way to the Session detail (transcript,
// changes, attestation).
//
// Why a tiny module instead of a direct call: the request comes from outside the
// Trace tree, and answering it takes two owners — App opens the Sessions tab,
// TraceSurface selects the row once that tab is mounted. A window event covers
// the already-mounted case; a module-level "pending" cell covers the first-mount
// case (the event can fire before TraceSurface exists). TraceSurface drains
// whichever arrives first and clears the other, so the row is never opened
// twice.

import type { IntentRow } from "./api";

/** Event name both App (open the tab / close the overlay) and TraceSurface
 *  (select the row) listen for. */
export const OPEN_SESSION_DETAIL_EVENT = "aura:open-session-detail";

/** First-mount handoff: set right before dispatch, drained by TraceSurface when
 *  the Sessions tab mounts after the event already fired. */
let pendingSessionRow: IntentRow | null = null;

/** Ask the app to open the Trace Session detail for `row`. Stashes the row for
 *  a not-yet-mounted TraceSurface, then dispatches the event for an already-live
 *  one. Callers don't care which path resolves it. */
export function requestOpenSessionDetail(row: IntentRow): void {
  pendingSessionRow = row;
  try {
    window.dispatchEvent(
      new CustomEvent(OPEN_SESSION_DETAIL_EVENT, { detail: { row } }),
    );
  } catch {
    /* SSR / no-window guard — the pending cell still covers mount. */
  }
}

/** Drain the pending row (mount path). Returns it once, then null — so a row is
 *  never reopened on a later mount. */
export function takePendingSessionDetail(): IntentRow | null {
  const r = pendingSessionRow;
  pendingSessionRow = null;
  return r;
}

/** Clear the pending cell without consuming (live-event path already handled
 *  it), so a subsequent mount doesn't reopen the same row. */
export function clearPendingSessionDetail(): void {
  pendingSessionRow = null;
}
