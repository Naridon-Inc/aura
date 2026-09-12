// Run with: bun test src/components/settings/auraProUsage.test.ts
//
// AURA-266. The panel said `Couldn't load your usage.` and stopped. These pin
// the three things that were missing: a reason that differs by cause, a note
// on whether Refresh can help, and evidence that a press was a fresh attempt.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { quotaFailure, lastTriedLabel } from "./auraProUsage";

describe("quotaFailure", () => {
  it("distinguishes not reaching the cloud from the cloud answering badly", () => {
    expect(quotaFailure("offline").title).not.toBe(quotaFailure("server").title);
    expect(quotaFailure("offline").title).toContain("reach");
    expect(quotaFailure("server").title).toContain("answer");
  });

  it("reassures that spend is still being counted, because it is", () => {
    // The number on screen is a reading of a ledger the cloud keeps. A failed
    // read is not lost usage, and it should not read like one.
    expect(quotaFailure("offline").hint).toContain("still counting");
  });

  it("says a build without the brain cannot be fixed by pressing Refresh", () => {
    const f = quotaFailure("unsupported");
    expect(f.retryable).toBe(false);
    expect(f.hint).toContain("Update Aura");
  });

  it("keeps the old sentence for a cause it does not recognise", () => {
    // An unknown kind must degrade to something true, not to a blank.
    expect(quotaFailure(undefined).title).toBe("Couldn’t load your usage.");
    expect(quotaFailure("wat").retryable).toBe(true);
  });

  it("never blames the reader for a server fault", () => {
    expect(quotaFailure("server").hint).toContain("Nothing on this machine");
  });
});

describe("lastTriedLabel", () => {
  const NOW = 1_700_000_000_000;

  it("says nothing before the first attempt", () => {
    expect(lastTriedLabel(null, NOW)).toBeNull();
  });

  it("marks a fresh press, which is the whole point", () => {
    // Refresh looked inert because a failed retry left the screen
    // byte-identical. This line is the only thing that changes.
    expect(lastTriedLabel(NOW, NOW)).toBe("Last tried just now");
    expect(lastTriedLabel(NOW - 2_000, NOW)).toBe("Last tried just now");
  });

  it("counts up through seconds, minutes and hours", () => {
    expect(lastTriedLabel(NOW - 30_000, NOW)).toBe("Last tried 30s ago");
    expect(lastTriedLabel(NOW - 5 * 60_000, NOW)).toBe("Last tried 5m ago");
    expect(lastTriedLabel(NOW - 3 * 3_600_000, NOW)).toBe("Last tried 3h ago");
  });

  it("does not go backwards if the clock does", () => {
    expect(lastTriedLabel(NOW + 10_000, NOW)).toBe("Last tried just now");
  });
});

describe("the Aura Pro panel", () => {
  const src = readFileSync(join(import.meta.dir, "BrainTab.tsx"), "utf8");

  it("no longer withholds the detail in the one case it is all there is", () => {
    // The bug, exactly: `err && (quota || expired)` printed the reason only
    // when something else was already explaining the failure.
    expect(src).not.toContain("err && (quota || expired)");
  });

  it("keeps the failure kind, so the sentence can depend on the cause", () => {
    expect(src).toContain("errKind");
    expect(src).toContain("quotaFailure(");
  });

  it("shows when it last tried", () => {
    expect(src).toContain("lastTriedLabel(");
  });
});
