import { describe, expect, test } from "bun:test";

import {
  diffOutcomeFor,
  unsavedEditsMessage,
  wouldClobberUnsavedEdits,
  type PendingDiff,
} from "./protocol";

// An agent asks Aura to show a change and then waits — for hours, if that's
// how long the person takes. Everything worth pinning here is about what we
// tell it when the waiting ends, because every wrong answer is expensive in
// a specific way: a false "saved" makes the agent build on a change that was
// never applied, and a false "rejected" makes it redo work that landed.

const PENDING: PendingDiff = {
  requestId: "r1",
  path: "/repo/src/main.rs",
  tabName: "main.rs (proposed)",
  original: "fn main() {}\n",
  proposed: "fn main() { println!(\"hi\"); }\n",
};

describe("how a diff tab ends", () => {
  test("a tab that is gone means the person said no", () => {
    expect(diffOutcomeFor(undefined)).toEqual({ outcome: "rejected" });
  });

  test("unsaved edits mean the person is still deciding", () => {
    const file = { current: PENDING.proposed, baseline: PENDING.original };
    expect(diffOutcomeFor(file)).toBeNull();
  });

  test("a buffer that matches disk again means it was saved", () => {
    const file = { current: PENDING.proposed, baseline: PENDING.proposed };
    expect(diffOutcomeFor(file)).toEqual({
      outcome: "saved",
      content: PENDING.proposed,
    });
  });

  test("we report what was actually written, not what was proposed", () => {
    // The person is free to fix up a proposal before accepting it. An agent
    // told its own text landed would then be reasoning about a file that
    // doesn't exist.
    const edited = "fn main() { println!(\"hello\"); }\n";
    const file = { current: edited, baseline: edited };
    expect(diffOutcomeFor(file)).toEqual({
      outcome: "saved",
      content: edited,
    });
  });

  test("closing wins over saving — a missing tab is never 'saved'", () => {
    // Both conditions can look true in the same tick if the tab is closed
    // right after a save; the tab's absence is checked first on purpose.
    expect(diffOutcomeFor(undefined)).toEqual({ outcome: "rejected" });
  });
});

describe("refusing to overwrite someone's unsaved work", () => {
  test("a dirty buffer blocks the diff", () => {
    expect(
      wouldClobberUnsavedEdits({ current: "edited", baseline: "on disk" }),
    ).toBe(true);
  });

  test("a clean buffer does not", () => {
    expect(
      wouldClobberUnsavedEdits({ current: "same", baseline: "same" }),
    ).toBe(false);
  });

  test("a file that isn't open cannot be clobbered", () => {
    expect(wouldClobberUnsavedEdits(undefined)).toBe(false);
  });

  test("the refusal names the file and says what to do, in plain words", () => {
    const msg = unsavedEditsMessage("/repo/src/main.rs");
    expect(msg).toContain("main.rs");
    expect(msg).not.toContain("/repo/src");
    expect(msg.toLowerCase()).toContain("save");
    // No jargon: this is read by whoever is watching the agent work.
    expect(msg.toLowerCase()).not.toContain("buffer");
    expect(msg.toLowerCase()).not.toContain("dirty");
  });
});
