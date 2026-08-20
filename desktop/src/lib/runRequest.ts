// "Run this project" has to survive the panel not existing yet.
//
// Only the terminal panel owns terminals, so only it can start one — but
// `Layout.tsx` renders the bottom pane solely while it is open, so pressing ⌘R
// with the panel closed means asking something that is not mounted. Opening the
// panel and firing an event on a `setTimeout(…, 0)` looks like it fixes that
// and does not: the timer is queued *before* React commits, while the effect
// that would subscribe flushes on React's own scheduler task. Whichever task
// runs first decides whether ⌘R works, and when the timer wins, nothing
// happens at all — indistinguishable from Run being broken.
//
// So the request waits for a listener rather than assuming one. It is held
// until something claims it, which makes "the panel mounts later" the ordinary
// path instead of a race.

let pending = false;
const listeners = new Set<() => void>();

/** Ask for the current project to run. Safe to call before anything can hear
 *  it — the request is held until a listener claims it. */
export function requestRun(): void {
  pending = true;
  for (const notify of [...listeners]) notify();
}

/** Take the outstanding request, if there is one. Returns false when there is
 *  nothing to do, so a re-subscribing listener can't run the project twice. */
export function claimRunRequest(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

/** Subscribe to run requests. A listener that arrives *after* the request —
 *  the panel mounting in response to it — is told immediately, which is the
 *  whole point. Returns the unsubscribe. */
export function onRunRequested(notify: () => void): () => void {
  listeners.add(notify);
  if (pending) notify();
  return () => {
    listeners.delete(notify);
  };
}

/** Testing seam: forget any unclaimed request. */
export function resetRunRequest(): void {
  pending = false;
  listeners.clear();
}
