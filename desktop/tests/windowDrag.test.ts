// A window drag that quits the app.
//
//   bun test
//
// From the crash log, at launch, with nobody touching the machine:
//
//   thread 'main' panicked at tao-0.35.2/src/platform_impl/macos/window.rs:936:36:
//   messsaging type to nil
//   error: script "tauri" exited with code 101
//
// Line 936 is the first statement of tao's `drag_window`:
//
//   let mut event: id = msg_send![&NSApp(mtm), currentEvent];
//   let event_type: NSUInteger = msg_send![event, type];   // <- 936
//
// `currentEvent` is nil whenever the app is not inside an event. The hop from
// a `mousedown` in the webview, through the IPC bridge, to the command running
// on the main thread is enough for that to be true — and it is *always* true
// for a drag started from a timer or a continuation, which is what the HUD's
// 4px-threshold pointermove does. Messaging nil panics; the panic is on the
// main thread inside an objc frame; the process goes with it.
//
// So this is not "the drag doesn't start". This is "Aura quits". Every JS
// caller now goes through one command that asks AppKit whether there is an
// event to drag from first.
//
// What this file holds: nothing may call `startDragging()` again, the guard
// may not be removed from the command, and the command has to be registered —
// an unregistered command fails at the bridge, which the callers all swallow,
// so the drag would quietly stop working everywhere at once.

import { describe, expect, test } from "bun:test";
import { readSrc, stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;

const rust = async (rel: string) =>
  stripComments(await Bun.file(`${SRC}/../src-tauri/src/${rel}`).text());

describe("no surface starts a drag on its own", () => {
  const CALLERS = [
    "components/TopBar.tsx",
    "components/SidebarHeader.tsx",
    "components/dialogs/SettingsDialog.tsx",
    "components/hud/HudApp.tsx",
  ];

  test("every drag goes through the guarded command", async () => {
    for (const rel of CALLERS) {
      const src = stripComments(await readSrc(rel));
      expect(src).not.toContain("startDragging(");
      expect(src).toContain("beginWindowDrag()");
    }
  });

  test("the wrapper never throws at its callers", async () => {
    // Three of the four call it from a mousedown handler that returns void,
    // and the fourth from a pointermove. A rejected promise from any of them
    // is an unhandled rejection in a window whose only job is chrome.
    const src = stripComments(await readSrc("lib/windowDrag.ts"));
    expect(src).toContain('invoke("window_start_drag")');
    expect(src).toContain("catch(() => {})");
  });
});

describe("the command asks before it drags", () => {
  test("it checks for a current event, and bails when there isn't one", async () => {
    const src = await rust("cmd_window.rs");
    const i = src.indexOf("pub fn window_start_drag");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n}\n", i));
    expect(body).toContain("has_current_event()");
    // The bail is a plain Ok — no event means no drag to start, which is not
    // an error worth surfacing to a mousedown handler.
    expect(body.replace(/\s+/g, "")).toContain("returnOk(());");
    // …and the guard is macOS-only, since that is where the panic lives.
    expect(body).toContain('#[cfg(target_os = "macos")]');
  });

  test("the check is a nil test, not a truthiness test", async () => {
    const src = await rust("cmd_window.rs");
    const i = src.indexOf("unsafe fn has_current_event");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n}\n", i));
    expect(body).toContain("currentEvent");
    // Specifically: the EVENT is the thing tested. `app.is_null()` below
    // satisfies a bare "contains is_null()" while the event goes unchecked,
    // which is the whole defect wearing a passing test.
    expect(body.replace(/\s+/g, "")).toContain("!event.is_null()");
    // NSApp itself can be nil before the app finishes launching, and the
    // crash we have is from launch.
    expect(body).toContain("app.is_null()");
  });

  test("the command is registered", async () => {
    // Every caller swallows the error, so an unregistered command doesn't
    // fail loudly — window dragging just stops, everywhere, silently.
    const lib = await rust("lib.rs");
    expect(lib).toContain("cmd_window::window_start_drag");
  });
});
