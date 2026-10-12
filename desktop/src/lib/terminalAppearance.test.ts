// The claim under test: the app's zoom reaches the native terminal.
//
// ⌘+ drives the webview's page zoom, which scales every pixel the webview
// draws. The GPU terminal is not one of them — it paints into a surface that
// is the webview's *sibling*, merely positioned in window points — so zooming
// in grew the hole and left the glyphs where they were: more columns of the
// same small text, which reads as a dead keypress. The size is multiplied in
// Rust (`cmd_native_term::appearance`), so what this pins is the half that can
// drift silently: that the push sends a `zoom` at all, under the name the
// backend deserializes, and that it does not quietly fold it into `fontPx`
// where the Appearance pane's own setting would overwrite it.

import { describe, expect, it, beforeEach, mock } from "bun:test";

type Payload = { appearance: { fontPx?: number; zoom?: number }; scale: number };

let lastCall: { cmd: string; payload: Payload } | null = null;

const invokeMock = mock(async (cmd: string, payload: Payload) => {
  lastCall = { cmd, payload };
  return 1;
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload: Payload) => invokeMock(cmd, payload),
}));

const { pushNativeTerminalAppearance } = await import("./terminalAppearance");

beforeEach(() => {
  lastCall = null;
  invokeMock.mockClear();
});

describe("pushNativeTerminalAppearance", () => {
  it("sends the zoom the caller was given", async () => {
    await pushNativeTerminalAppearance(13, 1.3);
    expect(lastCall?.cmd).toBe("native_term_set_appearance");
    expect(lastCall?.payload.appearance.zoom).toBe(1.3);
  });

  it("keeps the text size setting and the zoom as separate numbers", async () => {
    // Pre-multiplying here would land a zoomed size in the field the
    // Appearance pane also writes, so the next push from the slider would
    // reset the zoom and the next push from the keyboard would reset the
    // slider. Rust holds the two apart and multiplies at the point of use.
    await pushNativeTerminalAppearance(16, 1.5);
    expect(lastCall?.payload.appearance.fontPx).toBe(16);
    expect(lastCall?.payload.appearance.zoom).toBe(1.5);
  });

  it("still sends a zoom when the text size is left at the renderer's default", async () => {
    // `terminal.font_size` is null until somebody moves the slider, and the
    // backend then supplies its own default. The zoom has to arrive anyway —
    // otherwise ⌘+ worked only for users who had visited Settings.
    await pushNativeTerminalAppearance(null, 1.2);
    expect(lastCall?.payload.appearance.fontPx).toBeUndefined();
    expect(lastCall?.payload.appearance.zoom).toBe(1.2);
  });

  it("answers 0 rather than throwing when the backend is not there", async () => {
    // Called from theme-change and zoom listeners: a failed IPC must not take
    // the zoom or the theme switch down with it.
    invokeMock.mockImplementationOnce(async () => {
      throw new Error("no such command");
    });
    expect(await pushNativeTerminalAppearance(13, 1)).toBe(0);
  });
});
