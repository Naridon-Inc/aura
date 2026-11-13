// The toast stack is drawn by the page, and a running terminal is not: it is
// a native GPU surface placed over a hole the page leaves for it, so no
// z-index puts a toast above it. A toast over a terminal is readable only if
// the terminal steps off it, which takes two things the stack has to do and
// one the pane has to do. These pin all three, since none of them can be
// seen from a test without a window: a missing one is a toast painted over.
//
// The geometry itself — a bottom-right toast costs the terminal only the rows
// or columns it is on — is pinned in `src/lib/nativeSurfacePlacement.test.ts`.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const toaster = await readSrc("components/Toaster.tsx");
const terminal = await readSrc("components/NativeTerminal.tsx");
const placement = await readSrc("lib/nativeSurfacePlacement.ts");

describe("toasts over the native terminal", () => {
  test("each toast that paints is marked as an overlay to step off", () => {
    expect(toaster).toContain('data-over-native-surface={limited ? undefined : ""}');
    // The marker only counts because the pane's selector asks for it.
    expect(placement).toContain('"[data-over-native-surface]"');
  });

  test("the stack announces when its toasts come, go or move", () => {
    expect(toaster).toContain("announceOverlayChange();");
    expect(toaster).toContain("window.setTimeout(announceOverlayChange, EXIT_MS + 20)");
    // On the stack's shape — which toasts, where, how tall, fanned or not —
    // so a toast re-sent with new words does not make every terminal re-read.
    expect(toaster).toContain("}, [layout, fanned]);");
    expect(toaster).toContain("${e.toast.id}/${e.index}/${e.ending ? 1 : 0}/${heights[e.toast.id] ?? 0}");
  });

  test("the pane re-reads its clip on that announcement and stops on unmount", () => {
    expect(terminal).toContain(
      "window.addEventListener(NATIVE_OVERLAYS_CHANGED, scheduleOverlayCheck);",
    );
    expect(terminal).toContain(
      "window.removeEventListener(NATIVE_OVERLAYS_CHANGED, scheduleOverlayCheck);",
    );
  });
});
