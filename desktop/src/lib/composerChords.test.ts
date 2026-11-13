// Run with: bun test src/lib/composerChords.test.ts

import { describe, expect, test } from "bun:test";
import { modKeyLabel, modelSlotFromActionId } from "./composerChords";

describe("naming the modifier key the hint promises", () => {
  // The composer now prints its own chord ("⌘L to focus"). Every chord in
  // this module is handled as `metaKey || ctrlKey`, so the label has to name
  // the key that actually works on the machine reading it — a hint naming the
  // wrong key is worse than no hint, because it teaches a keystroke that does
  // nothing.

  test("Apple hardware gets the command glyph", () => {
    expect(modKeyLabel("MacIntel")).toBe("⌘");
    expect(modKeyLabel("MacArm")).toBe("⌘");
    expect(modKeyLabel("iPhone")).toBe("⌘");
  });

  test("everything else gets Ctrl", () => {
    expect(modKeyLabel("Win32")).toBe("Ctrl+");
    expect(modKeyLabel("Linux x86_64")).toBe("Ctrl+");
  });

  test("a platform that says nothing still answers from the user agent", () => {
    // Safari and recent Chrome freeze or empty navigator.platform, so the UA
    // is the fallback rather than a second opinion.
    expect(modKeyLabel("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("⌘");
    expect(modKeyLabel("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl+");
  });

  test("knowing nothing falls to Ctrl, not to the command glyph", () => {
    // Ctrl is the narrower risk: it exists on every keyboard including
    // Apple's, while ⌘ only exists on Apple hardware. Guessing ⌘ on a PC
    // prints a key the user does not have.
    expect(modKeyLabel("", "")).toBe("Ctrl+");
  });

  test("the label is pure — it never has to touch a navigator", () => {
    // Asserted by the three cases above running under bun, where there is no
    // `navigator` at all. If the function read the global unconditionally
    // those would throw rather than return.
    expect(typeof modKeyLabel("MacIntel")).toBe("string");
  });
});

describe("the model-slot chords", () => {
  test("a slot id yields its digit", () => {
    expect(modelSlotFromActionId("pick_model_1")).toBe(1);
    expect(modelSlotFromActionId("pick_model_5")).toBe(5);
  });

  test("anything else is not a slot", () => {
    expect(modelSlotFromActionId("pick_model_0")).toBeNull();
    expect(modelSlotFromActionId("pick_model_12")).toBeNull();
    expect(modelSlotFromActionId("toggle_fast")).toBeNull();
  });
});
