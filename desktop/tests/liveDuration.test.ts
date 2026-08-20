// A running timer counts in tenths.
//
// A once-a-second counter is frozen for ~900ms out of every 1000, and a
// number standing still next to a spinner is what a wedged turn looks like —
// the same wait reads as slower. Past a minute the decimal is noise, so the
// live formatter hands back to the settled ladder and the two never disagree
// about a value they both render.

import { describe, expect, it } from "bun:test";

import { formatDuration, formatLiveDuration } from "../src/lib/duration";
import { readSrc } from "./support/code";

describe("formatLiveDuration", () => {
  it("carries one decimal under a minute", () => {
    expect(formatLiveDuration(0)).toBe("0.0s");
    expect(formatLiveDuration(1.14)).toBe("1.1s");
    expect(formatLiveDuration(1.16)).toBe("1.2s");
    expect(formatLiveDuration(59.9)).toBe("59.9s");
  });

  it("never rounds itself up to a sixtieth second", () => {
    // 59.97 → "60.0s" would be a time that doesn't exist on this ladder.
    expect(formatLiveDuration(59.97)).toBe("1m");
    expect(formatLiveDuration(60)).toBe("1m");
  });

  it("hands back to the settled ladder past a minute", () => {
    for (const v of [61, 90, 3600, 7500]) {
      expect(formatLiveDuration(v)).toBe(formatDuration(v));
    }
  });

  it("treats junk as zero rather than printing NaN", () => {
    expect(formatLiveDuration(Number.NaN)).toBe("0.0s");
    expect(formatLiveDuration(-5)).toBe("0.0s");
  });
});

describe("the in-flight timers tick fast enough to show it", () => {
  it("the chat's Thinking/Planning line ticks at 10Hz", async () => {
    const src = await readSrc("components/manager/chat/StatusLine.tsx");
    expect(src).toContain("window.setInterval(tick, 100)");
    // Fractional — a floored second can't render a tenth.
    expect(src).not.toContain("Math.floor((Date.now() - (startRef.current as number)) / 1000)");
    const uses = src.match(/formatLiveDuration\(elapsedSec\)/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("the running-tool row ticks at 10Hz too", async () => {
    const src = await readSrc("components/manager/ManagerChatView.tsx");
    expect(src).toContain("setElapsed(Math.max(0, (Date.now() - start) / 1000))");
    expect(src).toContain("window.setInterval(tick, 100)");
    expect(src).toContain("formatLiveDuration(elapsed)");
  });

  it("leaves a FINISHED duration whole. 'Thought for 5s', not 5.0s", async () => {
    const src = await readSrc("components/manager/chat/ReasoningBlock.tsx");
    expect(src).not.toContain("formatLiveDuration");
  });
});
