// Run with: bun test src/components/workpanes/timeline/timelineLoad.test.ts
//
// AURA-267, the pane half. Pins that the wait is bounded, that the sentence at
// the end of it is concrete, and — the actual bug — that the retry button is
// wired to something that starts a new read rather than joining the stuck one.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
  loadNote,
  stageAt,
} from "./timelineLoad";

describe("stageAt", () => {
  it("says nothing at all about a read that is behaving", () => {
    expect(stageAt(0)).toBe("reading");
    expect(stageAt(SLOW_AFTER_MS - 1)).toBe("reading");
    expect(loadNote(stageAt(2_000), false).line).toBeNull();
  });

  it("admits to being slow before a reader has to wonder", () => {
    expect(stageAt(SLOW_AFTER_MS)).toBe("slow");
  });

  it("stops calling it slow and calls it stuck", () => {
    // The bug: after six seconds the pane said "taking longer than usual" and
    // said it forever, so a read that would never return was indistinguishable
    // from one about to land.
    expect(stageAt(STALLED_AFTER_MS)).toBe("stalled");
    expect(stageAt(120_000)).toBe("stalled");
  });

  it("bounds the wait somewhere a person would still be watching", () => {
    expect(STALLED_AFTER_MS).toBeGreaterThan(SLOW_AFTER_MS);
    expect(STALLED_AFTER_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("loadNote", () => {
  it("offers the escape hatch as soon as it admits to being slow", () => {
    expect(loadNote("slow", false).action).toBe("Start over");
  });

  it("says something different once starting over has already failed", () => {
    // Otherwise the reader presses the same button against the same sentence
    // and learns nothing from having pressed it.
    const first = loadNote("stalled", false).line;
    const again = loadNote("stalled", true).line;
    expect(first).not.toBe(again);
    expect(again).toContain("opening it again");
  });

  it("names a next step rather than only naming the problem", () => {
    expect(loadNote("stalled", false).line).toContain("Starting over");
  });

  it("stays in the reader's words", () => {
    const all = [
      loadNote("slow", false).line,
      loadNote("stalled", false).line,
      loadNote("stalled", true).line,
    ]
      .join(" ")
      .toLowerCase();
    for (const jargon of ["engine", "async", "runtime", "backend", "subprocess", "numstat"]) {
      expect(all).not.toContain(jargon);
    }
  });
});

describe("the timeline pane", () => {
  const src = readFileSync(join(import.meta.dir, "TimelinePane.tsx"), "utf8");

  it("retries with a read that actually restarts", () => {
    // `refreshIntentRows` hands back the read already running, so a button
    // wired to it recovers nothing. This is the whole defect.
    expect(src).toContain("restartIntentRead");
    expect(src).not.toContain("refreshIntentRows");
  });

  it("no longer promises indefinitely that it is taking longer than usual", () => {
    expect(src).not.toContain("Taking longer than usual");
  });

  it("drives its copy from the bounded stages", () => {
    expect(src).toContain("stageAt(");
    expect(src).toContain("loadNote(");
  });
});
