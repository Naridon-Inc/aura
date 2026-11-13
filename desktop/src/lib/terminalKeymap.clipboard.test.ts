// The claim under test: a terminal's ⌘C and ⌘V go through Rust, and neither
// key is ever handed back to the webview.
//
// Both halves had failed silently. `navigator.clipboard.readText()` is gated
// behind a paste gesture WKWebView never grants, so ⌘V read nothing and
// pasted nothing; and a ⌘C with nothing selected was passed through, reached
// WebKit, found nothing that could service `copy:`, and rang the macOS error
// bell. What is pinned here is that the keys are consumed and that the
// clipboard is the Rust one — a regression to `navigator` would be invisible
// in a browser test environment, where it works.

import { describe, expect, it, beforeEach, mock } from "bun:test";

let invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
let clipboardText = "";
let hasImage = false;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "clipboard_read_text") return clipboardText;
    if (cmd === "clipboard_has_image") return hasImage;
    return undefined;
  },
}));

const { handleClipboardKey } = await import("./terminalKeymap");

type Call = { pasted: string[]; bytes: number[][] };

function io(selection = ""): ClipboardSpy {
  const calls: Call = { pasted: [], bytes: [] };
  return {
    calls,
    getSelection: () => selection,
    paste: (text: string) => calls.pasted.push(text),
    writeBytes: (bytes: number[]) => calls.bytes.push(bytes),
  };
}

type ClipboardSpy = {
  calls: Call;
  getSelection: () => string;
  paste: (text: string) => void;
  writeBytes: (bytes: number[]) => void;
};

// A literal rather than `new KeyboardEvent`: these tests run headless, with
// no DOM, and the handler reads four fields.
function key(
  k: string,
  init: { type?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return {
    type: "keydown",
    key: k,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    ...init,
  } as unknown as KeyboardEvent;
}

// The handler kicks off async clipboard work and returns immediately; the
// caller needs the verdict synchronously to decide about preventDefault.
const settled = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoked = [];
  clipboardText = "";
  hasImage = false;
});

describe("⌘V", () => {
  it("pastes the text Rust read, which the terminal then fences itself", async () => {
    clipboardText = "echo hi";
    const spy = io();
    expect(handleClipboardKey(key("v"), spy)).toBe(true);
    await settled();

    expect(invoked.map((i) => i.cmd)).toContain("clipboard_read_text");
    expect(spy.calls.pasted).toEqual(["echo hi"]);
    // No hand-rolled envelope: bracketing belongs to whoever knows the mode.
    expect(spy.calls.bytes).toEqual([]);
  });

  it("strips a closing fence the pasted text carries", async () => {
    clipboardText = "safe\x1b[201~rm -rf /";
    const spy = io();
    handleClipboardKey(key("v"), spy);
    await settled();
    expect(spy.calls.pasted).toEqual(["saferm -rf /"]);
  });

  it("forwards Ctrl+V for an image, which cannot go down a PTY", async () => {
    hasImage = true;
    const spy = io();
    handleClipboardKey(key("v"), spy);
    await settled();
    expect(spy.calls.bytes).toEqual([[0x16]]);
    expect(spy.calls.pasted).toEqual([]);
  });

  it("sends nothing at all when the clipboard is empty", async () => {
    const spy = io();
    expect(handleClipboardKey(key("v"), spy)).toBe(true);
    await settled();
    expect(spy.calls.pasted).toEqual([]);
    expect(spy.calls.bytes).toEqual([]);
  });
});

describe("⌘C", () => {
  it("writes the selection through Rust, not the webview", async () => {
    const spy = io("selected words");
    expect(handleClipboardKey(key("c"), spy)).toBe(true);
    await settled();

    const write = invoked.find((i) => i.cmd === "clipboard_write_text");
    expect(write?.args).toEqual({ text: "selected words" });
  });

  // The bell itself: an unconsumed ⌘C reaches WebKit, which has nothing that
  // can copy, and macOS beeps. Consuming it is the fix.
  it("is consumed even with nothing selected, so nothing beeps", async () => {
    const spy = io("");
    expect(handleClipboardKey(key("c"), spy)).toBe(true);
    await settled();
    expect(invoked.find((i) => i.cmd === "clipboard_write_text")).toBeUndefined();
  });
});

describe("keys that are not ours", () => {
  it("leaves ⌃C alone — that is interrupt, not copy", () => {
    expect(handleClipboardKey(key("c", { metaKey: false, ctrlKey: true }), io("x"))).toBe(false);
  });

  it("leaves a bare V and ⌥⌘V alone", () => {
    expect(handleClipboardKey(key("v", { metaKey: false }), io())).toBe(false);
    expect(handleClipboardKey(key("v", { altKey: true }), io())).toBe(false);
  });

  it("ignores keyup, which would otherwise paste twice", () => {
    expect(handleClipboardKey(key("v", { type: "keyup" }), io())).toBe(false);
  });
});
