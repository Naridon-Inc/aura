// Starting a window drag from JS.
//
// Every strip that acts as a title bar wants `getCurrentWindow().startDragging()`
// on mousedown. That call lands in tao's `drag_window`, which messages
// `NSApp().currentEvent` without checking it for nil — and it IS nil whenever
// the app isn't inside an event, which the async hop from the webview's
// mousedown to the main thread is enough to make true. Messaging nil panics on
// the main thread inside an objc frame, and that doesn't fail the drag: it
// quits Aura. We have a crash log of exactly that, at launch, with nobody
// touching the machine.
//
// So the drag goes through our own command (src-tauri/cmd_window.rs), which
// asks AppKit whether there's an event to drag from before it starts one.
// Best-effort by design: off macOS, in the web preview, or before the command
// is wired, it silently no-ops — same contract as trafficLights.ts.

import { invoke } from "@tauri-apps/api/core";

/** Begin dragging the window this webview lives in. Never throws. */
export function beginWindowDrag(): void {
  void invoke("window_start_drag").catch(() => {});
}
