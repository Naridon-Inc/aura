import { describe, expect, it } from "bun:test";

import { keyEventToBytes } from "./nativeTerminalKeys";

/** A keydown shaped like the DOM one, with only the fields the encoder reads. */
function keydown(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent;
}

describe("keyEventToBytes", () => {
  it("encodes a plain control chord as its C0 code", () => {
    // Ctrl+F is forward-char and Ctrl+A beginning-of-line; readline owns both,
    // so they have to reach the shell.
    expect(keyEventToBytes(keydown("f", { ctrlKey: true }))).toBe("\x06");
    expect(keyEventToBytes(keydown("a", { ctrlKey: true }))).toBe("\x01");
    expect(keyEventToBytes(keydown("c", { ctrlKey: true }))).toBe("\x03");
  });

  it("leaves Ctrl+Shift+<letter> to the app", () => {
    // These are how a terminal spells its own commands on Linux and Windows:
    // copy, paste, find. Encoding them sent the same byte as plain Ctrl, so
    // the shell acted on a find and readline moved the cursor under it.
    for (const key of ["c", "v", "f", "k", "a"]) {
      expect(keyEventToBytes(keydown(key, { ctrlKey: true, shiftKey: true }))).toBeNull();
    }
  });

  it("leaves Ctrl+Alt chords to the app, as it did before", () => {
    // Not something this change decided: the C0 branch has always required
    // Alt to be clear. Asserted so the shift guard above cannot be blamed for
    // it later.
    expect(keyEventToBytes(keydown("f", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("leaves ⌘ chords alone", () => {
    expect(keyEventToBytes(keydown("k", { metaKey: true }))).toBeNull();
    expect(keyEventToBytes(keydown("a", { metaKey: true }))).toBeNull();
  });

  it("encodes a shifted printable character as itself", () => {
    // Shift alone is not a chord: an uppercase letter is just that letter.
    expect(keyEventToBytes(keydown("F", { shiftKey: true }))).toBe("F");
  });
});
