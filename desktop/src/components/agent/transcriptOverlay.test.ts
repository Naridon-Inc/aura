// Run with: bun test src/components/agent/transcriptOverlay.test.ts
//
// The agent pane opens on the terminal, with the conversation layer laid over
// it: invisible, all but its composer dock. The terminal is a native GPU
// surface, the webview's sibling, and before it paints it asks the page
// whether anything is in front of its hole: `elementFromPoint` at five points
// (`isCovered`). Anything that comes back from all five that is not the hole,
// inside it, or one of its ancestors means "a page is over me", and the
// surface parks.
//
// The conversation layer's wrapper is a full-pane box. Drawing nothing does
// not take a box out of hit testing, so with the pointer left on it every
// sample found the wrapper and the pane showed blank until a click happened to
// change the answer. These tests pin both halves: what the check does with such
// a box, and that the wrapper gives the pointer up over the terminal.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isCovered, type Bounds } from "../../lib/nativeSurfacePlacement";

/** A stand-in element: just enough of `Element` for `isCovered`, which only
 *  asks what contains what. */
function node(name: string, children: Element[] = []): Element {
  const self = {
    name,
    contains(other: Element): boolean {
      return other === (self as unknown as Element) || children.some((c) => c.contains(other));
    },
  };
  return self as unknown as Element;
}

const HOLE: Bounds = { x: 0, y: 0, w: 800, h: 600 };

describe("what the cover check makes of the conversation layer", () => {
  const hole = node("terminal hole");
  const terminalLayer = node("terminal layer", [hole]);
  const transcriptWrapper = node("transcript wrapper");
  const root = node("html", [terminalLayer, transcriptWrapper]);

  test("a hit-testable full-pane wrapper parks the terminal", () => {
    // What the pane did: every sample landed on the wrapper.
    expect(isCovered(hole, HOLE, () => transcriptWrapper)).toBe(true);
  });

  test("a click-through wrapper lets every sample reach the terminal", () => {
    // `pointer-events: none` on the wrapper: the hit test falls through to the
    // terminal layer (an ancestor of the hole) or the hole itself.
    expect(isCovered(hole, HOLE, () => terminalLayer)).toBe(false);
    expect(isCovered(hole, HOLE, () => hole)).toBe(false);
    expect(isCovered(hole, HOLE, () => root)).toBe(false);
  });

  test("the composer dock over one corner of the hole does not park it", () => {
    // The dock keeps the pointer (it is real UI). It covers at most the bottom
    // of the pane, so some samples always reach the terminal.
    const dock = node("dock");
    const topmostAt = (_x: number, y: number) => (y > HOLE.h * 0.7 ? dock : hole);
    expect(isCovered(hole, HOLE, topmostAt)).toBe(false);
  });
});

describe("the wiring in the agent pane", () => {
  const surface = readFileSync(join(import.meta.dir, "AgentSurface.tsx"), "utf8");
  const chatView = readFileSync(join(import.meta.dir, "chatView.css"), "utf8");

  test("the conversation wrapper gives up the pointer whenever the terminal is showing", () => {
    const start = surface.indexOf("{!paused && (");
    const end = surface.indexOf("<NormalizedTranscript", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wrapper = surface.slice(start, end);
    // Click-through in every view but the conversation, where the transcript
    // itself is what you scroll, select and click.
    expect(wrapper).toMatch(
      /view === "chat" \? "absolute inset-0" : "absolute inset-0 pointer-events-none"/,
    );
    // And the overlay flag it is paired with is the same condition.
    expect(surface).toMatch(/overlay=\{view !== "chat"\}/);
  });

  test("the dock takes the pointer back, so the composer still works", () => {
    const dockRule = chatView.slice(
      chatView.indexOf(".chat-workspace[data-chat-overlay] .chat-dock {"),
    );
    expect(dockRule.slice(0, dockRule.indexOf("}"))).toMatch(/pointer-events:\s*auto/);
  });
});
