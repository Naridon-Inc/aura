// Which thrown values are real failures and which are teardown noise.
//
// Lives here, not in the error boundary, because two callers need the same
// answer for different reasons: the boundary must not blank the app over a
// disposed Monaco model, and telemetry must not report one as an error —
// a metric that counts every ResizeObserver warning tells you nothing about
// whether the app is actually breaking for people.

// Some runtime errors are pure noise and must NOT blank the app:
//  • "ResizeObserver loop …" — a benign layout-thrash warning every browser
//    emits; it is not an actual failure.
//  • Tauri's event teardown race — `unlisten()` is async and its internal
//    `unregisterListener` reads `listeners[eventId].handlerId` with no guard.
//    When a listener is torn down twice (fast unmount, an effect re-running on
//    boot), the already-removed entry is `undefined` and it throws. The
//    listener is *already gone*, so this is harmless — but as an unhandled
//    rejection it would otherwise trip the snag screen on launch. Swallow it.
export function isBenignRuntimeNoise(message: string): boolean {
  if (!message) return false;
  if (message.includes("ResizeObserver loop")) return true;
  if (message.includes("handlerId") || message.includes("unregisterListener"))
    return true;
  //  • Monaco / VS Code cancellation — a `CancellationError` (name === message
  //    === "Canceled") is thrown routinely when an editor or model is disposed
  //    while an async op (tokenization, hover, diff compute, the loader's init)
  //    is still in flight. The work was simply abandoned; nothing failed. But
  //    Monaco surfaces it as an unhandled promise rejection, so without this
  //    guard a user closing a file mid-highlight gets blanked into the snag
  //    screen. VS Code's own global handler ignores CancellationError for the
  //    same reason. Match the bare message and the "Canceled: Canceled"
  //    name:message form, both US and UK spelling.
  const t = message.trim();
  if (t === "Canceled" || t === "Cancelled") return true;
  if (t.includes("Canceled: Canceled") || t.includes("Cancelled: Cancelled"))
    return true;
  //  • Monaco diff-editor teardown race — `@monaco-editor/react`'s DiffEditor
  //    frees the original/modified TextModels BEFORE the DiffEditorWidget that
  //    still references them (its unmount cleanup disposes the models first, the
  //    widget last), so newer Monaco's "reset the model before you dispose it"
  //    invariant fires "TextModel got disposed before DiffEditorWidget model got
  //    reset". It's a pure ordering assertion while the pane is already
  //    unmounting — the models get disposed either way, nothing failed — but
  //    React surfaces it from the passive unmount effect straight to this
  //    boundary, so without this guard closing a diff (or switching the file it
  //    shows) would blank the app into the snag screen.
  if (t.includes("DiffEditorWidget model got reset")) return true;
  return false;
}

// A thrown value is a Monaco/VS Code cancellation if its name marks it so —
// checked separately because some cancellations carry an empty message.
export function isCancellation(reason: unknown): boolean {
  const name = reason instanceof Error ? reason.name : "";
  return name === "Canceled" || name === "Cancelled" || name === "CancellationError";
}

/** True when this thrown value is teardown noise rather than a real failure. */
export function isIgnorableThrow(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return isBenignRuntimeNoise(message) || isCancellation(reason);
}
