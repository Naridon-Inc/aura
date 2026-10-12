// The claim under test: the answer survives the roll-up.
//
// Folding a turn's steps into one line is only safe if the split cannot eat
// the thing the agent was trying to say, and cannot dress a plain reply up as
// work. Those are the two ways this goes wrong, and both are below.

import { describe, expect, it } from "bun:test";

import { splitSettledTurn } from "./turnSplit";
import type { StreamBlock } from "../../manager/chat/types";

let idx = 0;
const text = (t: string): StreamBlock => ({ kind: "text", block_idx: idx++, text: t });
const thought = (t: string): StreamBlock => ({
  kind: "reasoning",
  block_idx: idx++,
  text: t,
});
const tool = (name: string): StreamBlock => ({
  kind: "tool",
  block_idx: idx++,
  tool_use_id: `t${idx}`,
  name,
  input: {},
});

describe("splitSettledTurn", () => {
  it("keeps a plain reply whole, with no step-run invented for it", () => {
    // A turn that did nothing must not render a "worked through 0 steps" line.
    const blocks = [text("Yes, that is already on main.")];
    expect(splitSettledTurn(blocks)).toEqual({ steps: [], answer: blocks });
  });

  it("folds the work and keeps the closing prose as the answer", () => {
    // The shape from a real session: narrate, act, narrate, act, conclude.
    const a = thought("checking mergeability");
    const b = tool("Bash");
    const c = text("Pushed. Refreshing PR state now.");
    const d = tool("Bash");
    const e = text("Checked latest. #638 merged.");
    const out = splitSettledTurn([a, b, c, d, e]);
    expect(out.answer).toEqual([e]);
    expect(out.steps).toEqual([a, b, c, d]);
  });

  it("treats an unbroken run of closing paragraphs as one answer", () => {
    // Markdown arrives as several text blocks; the answer is all of them, not
    // just the last paragraph.
    const a = tool("Bash");
    const b = text("Checked latest.");
    const c = text("- #638: merged");
    const d = text("Verified: build passed.");
    const out = splitSettledTurn([a, b, c, d]);
    expect(out.answer).toEqual([b, c, d]);
    expect(out.steps).toEqual([a]);
  });

  it("gives a turn that ended on a command no answer rather than a wrong one", () => {
    // Nothing was said at the end, so nothing is promoted. The roll-up stands
    // alone instead of borrowing an earlier line of narration as a conclusion.
    const a = text("Running the suite now.");
    const b = tool("Bash");
    const out = splitSettledTurn([a, b]);
    expect(out.answer).toEqual([]);
    expect(out.steps).toEqual([a, b]);
  });

  it("loses nothing: every block lands on exactly one side", () => {
    // The property that makes the fold safe to ship.
    const blocks = [thought("x"), text("a"), tool("Read"), text("b"), text("c")];
    const { steps, answer } = splitSettledTurn(blocks);
    expect([...steps, ...answer]).toEqual(blocks);
  });

  it("handles an empty turn without inventing either half", () => {
    expect(splitSettledTurn([])).toEqual({ steps: [], answer: [] });
  });
});
