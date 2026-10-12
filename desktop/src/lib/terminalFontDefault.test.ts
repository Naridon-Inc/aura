// The claim under test: there is ONE default terminal text size, and Rust owns it.
//
// There were four. `defaultTerminalFontSize()` answered 12 on macOS and 14
// elsewhere, `Terminal.tsx` carried its own copy of that same platform check,
// `AgentXtermCanvas` used 12.5, and `DEFAULT_FONT_PX` in the wgpu renderer —
// the engine that is actually on screen by default — drew 13. The visible
// symptom was a Settings slider reading 12 above a terminal rendering 13:
// dragging it to the value it already displayed made the text jump.
//
// Rust owns the number because Rust does the drawing. The frontend has to
// state it rather than fetch it (the slider and both xterm constructors need
// it synchronously, mid-construction), so this is the guard that keeps the
// restatement honest: it reads the constant out of the Rust source and fails
// if the two stop agreeing. A comment asking the next person to keep two
// numbers in step is a wish; this is a check.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TERMINAL_FONT_PX, defaultTerminalFontSize } from "./settingsStore";

const APPEARANCE_RS = join(
  import.meta.dir,
  "..",
  "..",
  "src-tauri",
  "src",
  "cmd_native_term",
  "appearance.rs",
);

/** `DEFAULT_FONT_PX` as the renderer declares it. */
function rustDefaultFontPx(): number {
  const src = readFileSync(APPEARANCE_RS, "utf8");
  const m = src.match(/pub const DEFAULT_FONT_PX:\s*f32\s*=\s*([\d.]+)\s*;/);
  if (!m) {
    throw new Error(
      `DEFAULT_FONT_PX not found in ${APPEARANCE_RS} — if it was renamed or moved, ` +
        "point this test at its new home rather than deleting the check.",
    );
  }
  return parseFloat(m[1]);
}

describe("the default terminal text size", () => {
  it("is the number the renderer actually draws", () => {
    expect(DEFAULT_TERMINAL_FONT_PX).toBe(rustDefaultFontPx());
  });

  it("is what the Settings slider displays when nothing is set", () => {
    // The slider renders `terminal.font_size ?? defaultTerminalFontSize()`, so
    // this function is literally the number a fresh profile shows.
    expect(defaultTerminalFontSize()).toBe(rustDefaultFontPx());
  });

  it("does not vary by platform, because the drawing engine does not", () => {
    // The old answer branched on `navigator.platform`. The wgpu renderer has
    // no such branch, so a split here could only ever disagree with it on one
    // of the two platforms.
    expect(defaultTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_PX);
    expect(Number.isFinite(DEFAULT_TERMINAL_FONT_PX)).toBe(true);
  });

  it("is the only default the xterm panes fall back to", () => {
    // Both xterm views are fallbacks for a wgpu pane, so a default of their
    // own would show up as the text resizing when the engine changed — which
    // is exactly what 12-on-macOS and 12.5 did.
    const roots = ["../components/Terminal.tsx", "../components/agent/AgentXtermCanvas.tsx"];
    for (const rel of roots) {
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      const fallbacks = src.match(/font_size \?\? [^,\n]+/g) ?? [];
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const f of fallbacks) {
        expect(f).toBe("font_size ?? defaultTerminalFontSize()");
      }
    }
  });
});
