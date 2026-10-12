// A split pane that renders nothing is worse than a split pane that is gone.
//
// Someone closed a tab, the split kept the leaf that pointed at it, and the
// layout was left with a full-height blank column: no tab strip, so no close
// button; no content, so nothing to grab; and the resize handle sat against
// an empty cell. The only way out was clearing the whole layout and losing
// every other pane with it. These are the two decisions that let that happen.

import { describe, expect, test } from "bun:test";

import { activeRefForLeaf, dropEmptyCells } from "./splitPaneCells";

const file = (path: string) => ({ kind: "file" as const, path });
const agent = (id: string) => ({ kind: "agent" as const, id });

describe("choosing which tab a pane shows", () => {
  test("the focused tab, when the index points at one", () => {
    expect(
      activeRefForLeaf({ tabs: [file("a.ts"), agent("s1")], activeIndex: 1 }),
    ).toEqual(agent("s1"));
  });

  test("an index past the end falls back to the first tab, not to nothing", () => {
    // Closing tabs can leave activeIndex stale. Reporting "nothing" here is
    // what cost the pane its tab strip, and the strip is how it gets closed.
    expect(
      activeRefForLeaf({ tabs: [file("a.ts")], activeIndex: 4 }),
    ).toEqual(file("a.ts"));
  });

  test("a negative index is still an index past the end", () => {
    expect(
      activeRefForLeaf({ tabs: [file("a.ts")], activeIndex: -1 }),
    ).toEqual(file("a.ts"));
  });

  test("only a pane with no tabs at all reports nothing", () => {
    expect(activeRefForLeaf({ tabs: [], activeIndex: 0 })).toBeNull();
  });
});

describe("handing cells to a split container", () => {
  test("a child that rendered nothing gets no cell", () => {
    expect(dropEmptyCells(["left", null, "right"])).toEqual(["left", "right"]);
  });

  test("undefined and false count as nothing too", () => {
    // `cond && <Pane/>` renders false, not null.
    expect(dropEmptyCells(["left", undefined, false, "right"])).toEqual([
      "left",
      "right",
    ]);
  });

  test("the surviving count is what weights get normalized against", () => {
    // Two panes drawn out of three means two cells, so the split reads as a
    // half/half row — not a third of the width donated to empty space.
    expect(dropEmptyCells([1, null, 3]).length).toBe(2);
  });

  test("0 and the empty string are real children and keep their cells", () => {
    expect(dropEmptyCells([0, "", "right"])).toEqual([0, "", "right"]);
  });

  test("a full row is passed through untouched", () => {
    expect(dropEmptyCells(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
