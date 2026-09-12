// ⌘⌥← / ⌘⌥→ walk every tab across every pane and wrap at the ends.

import { describe, expect, test } from "bun:test";

import { cycleSlot, flattenSlots, slotPosition } from "../src/lib/tabCycle";

const panes = [
  { paneId: "a", count: 2, activeIndex: 1 },
  { paneId: "b", count: 3, activeIndex: 0 },
];

describe("flattenSlots", () => {
  test("lists every tab in strip order", () => {
    expect(flattenSlots(panes)).toEqual([
      { paneId: "a", index: 0 },
      { paneId: "a", index: 1 },
      { paneId: "b", index: 0 },
      { paneId: "b", index: 1 },
      { paneId: "b", index: 2 },
    ]);
  });

  test("an empty pane contributes nothing", () => {
    expect(flattenSlots([{ paneId: "x", count: 0, activeIndex: 0 }])).toEqual([]);
  });
});

describe("cycleSlot", () => {
  test("steps forward within a pane", () => {
    expect(cycleSlot(panes, { paneId: "a", index: 0 }, 1)).toEqual({ paneId: "a", index: 1 });
  });

  test("crosses into the next pane at a pane edge", () => {
    expect(cycleSlot(panes, { paneId: "a", index: 1 }, 1)).toEqual({ paneId: "b", index: 0 });
    expect(cycleSlot(panes, { paneId: "b", index: 0 }, -1)).toEqual({ paneId: "a", index: 1 });
  });

  test("wraps around both ends", () => {
    expect(cycleSlot(panes, { paneId: "b", index: 2 }, 1)).toEqual({ paneId: "a", index: 0 });
    expect(cycleSlot(panes, { paneId: "a", index: 0 }, -1)).toEqual({ paneId: "b", index: 2 });
  });

  test("with no current slot it starts from the first pane's raised tab", () => {
    // Pane a has tab 1 raised, so the first step forward lands on b/0.
    expect(cycleSlot(panes, null, 1)).toEqual({ paneId: "b", index: 0 });
  });

  test("a current slot the layout no longer has is treated like none", () => {
    expect(cycleSlot(panes, { paneId: "gone", index: 4 }, 1)).toEqual({ paneId: "b", index: 0 });
  });

  test("nothing to cycle with one tab or none", () => {
    expect(cycleSlot([{ paneId: "a", count: 1, activeIndex: 0 }], { paneId: "a", index: 0 }, 1)).toBeNull();
    expect(cycleSlot([], null, 1)).toBeNull();
  });
});

describe("slotPosition", () => {
  test("null current is -1", () => {
    expect(slotPosition(flattenSlots(panes), null)).toBe(-1);
  });
});
