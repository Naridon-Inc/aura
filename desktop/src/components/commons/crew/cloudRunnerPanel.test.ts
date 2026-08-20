import { describe, expect, test } from "bun:test";

import { blockedNote } from "./CloudRunnerPanel";
import type { CloudRunner } from "../../../lib/api";

// A runner that can't authenticate its agent still registers, still beats, and
// still reports `idle`. Every signal the board reads says "Ready" while the box
// fails everything it claims. The only channel carrying the truth is the note
// the runner writes onto its heartbeat, so these cover the seam it crosses.

function runner(current_task: string | null): CloudRunner {
  return {
    id: "r1",
    name: "aura-runner",
    agent_kinds: ["claude"],
    version: "0.19.35",
    status: "idle",
    last_heartbeat_at: "2026-08-02T00:12:00Z",
    current_task,
    online: true,
  };
}

describe("a machine that can't sign in", () => {
  test("its reason is read off the heartbeat", () => {
    const note = blockedNote(
      runner("Needs sign-in — this machine has no credential for claude"),
    );
    expect(note).toContain("no credential for claude");
  });

  test("a working machine reports nothing to answer for", () => {
    expect(blockedNote(runner("drained 2 project(s)"))).toBeNull();
    expect(blockedNote(runner(""))).toBeNull();
    // A row that has never beaten leaves this null rather than empty.
    expect(blockedNote(runner(null))).toBeNull();
  });

  test("the lead phrase survives the whitespace a beat may carry", () => {
    expect(blockedNote(runner("  Needs sign-in — no credential  "))).toBe(
      "Needs sign-in — no credential",
    );
  });
});
