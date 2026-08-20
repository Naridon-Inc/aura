import { describe, expect, test } from "bun:test";

import { reframe } from "./agentSessionStore";

// `reframe` is one half of a pair: the backend runs `reframe_text` in
// cmd_agent_pty.rs over its own copy of the same block, and hands that copy
// back on replay. These cases are the Rust module's cases, so the two stay
// one implementation in two languages — if they drift, a transcript changes
// under you the moment you leave the tab and come back.

describe("rewriting the tail of a block", () => {
  test("nothing to drop is an ordinary append", () => {
    expect(reframe("first\nsecond", 0, ["third"])).toBe("first\nsecond\nthird");
  });

  test("a dropped line is replaced by what came in its place", () => {
    expect(reframe("done\nWorking (1s)", 1, ["Working (2s)"])).toBe(
      "done\nWorking (2s)",
    );
  });

  test("the first update of a block does not open with a blank line", () => {
    // "".split("\n") is [""], so a naive splice would put a newline above the
    // very first line of every block.
    expect(reframe("", 0, ["hello"])).toBe("hello");
  });

  test("dropping more lines than exist empties the block rather than going negative", () => {
    expect(reframe("a\nb", 9, ["fresh"])).toBe("fresh");
  });

  test("a spinner rewriting itself never grows the block", () => {
    let text = reframe("", 0, ["Working (0s)"]);
    for (let s = 1; s <= 20; s += 1) {
      text = reframe(text, 1, [`Working (${s}s)`]);
    }
    expect(text).toBe("Working (20s)");
  });

  test("a full-screen redraw replaces the screen it drew over", () => {
    const screen = ["menu 1", "menu 2", "menu 3"];
    const after = reframe(`banner\n${screen.join("\n")}`, 3, [
      "menu 1 (current)",
      "menu 2",
      "menu 3",
    ]);
    expect(after).toBe("banner\nmenu 1 (current)\nmenu 2\nmenu 3");
  });
});
