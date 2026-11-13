// Run with: bun test src/components/ui/use-pointer-drag.test.ts
//
// The desktop app's web view never delivers an HTML5 `dragover` or `drop`
// (Tauri's native drag handler claims every drag before WebKit sees it), so
// reorders are pointer-driven. These pin the two decisions that drive one:
// when a press turns into a drag, and which target a release lands on. The
// whole gesture is exercised with real input against the running page; the
// placement it ends in is pinned here too.

import { describe, expect, test } from "bun:test";
import { DRAG_THRESHOLD, dropNodeFrom, dropTarget, dropTargetFrom, isDragMove, type DropNode } from "./use-pointer-drag";
import { LOADOUT_SLOTS, placeInLoadout } from "./model-loadout";

/** An element chain, innermost first: `[child, parent, …]`. */
function chain(...data: Array<Record<string, string> | undefined>): DropNode {
  let parent: DropNode | null = null;
  for (const dataset of data.slice().reverse()) parent = { dataset, parentElement: parent };
  return parent as DropNode;
}

describe("a press becomes a drag", () => {
  test("only once it has travelled the threshold", () => {
    const start = { x: 10, y: 10 };
    expect(isDragMove(start, { x: 10, y: 10 })).toBe(false);
    expect(isDragMove(start, { x: 12, y: 11 })).toBe(false);
    expect(isDragMove(start, { x: 10 + DRAG_THRESHOLD, y: 10 })).toBe(true);
    expect(isDragMove(start, { x: 7, y: 6 })).toBe(true);
  });

  test("so a click's small wobble is still a click", () => {
    expect(DRAG_THRESHOLD).toBeGreaterThan(2);
  });
});

describe("the target a release lands on", () => {
  test("is the nearest marked ancestor of the element under the pointer", () => {
    const node = chain(undefined, { pointerDropScope: "a", pointerDrop: "2" }, undefined);
    expect(dropTargetFrom(node, "a")).toBe("2");
  });

  test("is the target itself when the pointer is right on it", () => {
    expect(dropTargetFrom(chain({ pointerDropScope: "a", pointerDrop: "0" }), "a")).toBe("0");
  });

  test("belongs to this drag, never to another list on the page", () => {
    const node = chain({ pointerDropScope: "b", pointerDrop: "1" }, { pointerDropScope: "a", pointerDrop: "4" });
    expect(dropTargetFrom(node, "a")).toBe("4");
    expect(dropTargetFrom(chain({ pointerDropScope: "b", pointerDrop: "1" }), "a")).toBeUndefined();
  });

  test("is nothing over empty space, so the drop is cancelled", () => {
    expect(dropTargetFrom(chain(undefined, undefined), "a")).toBeUndefined();
    expect(dropTargetFrom(null, "a")).toBeUndefined();
  });

  test("hands back the target element itself, so a drop can tell which half it hit", () => {
    const node = chain(undefined, { pointerDropScope: "a", pointerDrop: "2" });
    expect(dropNodeFrom(node, "a")).toBe(node.parentElement ?? undefined);
  });

  test("can sit in another component, marked with the drag's shared scope", () => {
    const marks = dropTarget("tabs", "pane-2");
    const node = chain({ pointerDropScope: marks["data-pointer-drop-scope"], pointerDrop: marks["data-pointer-drop"] });
    expect(dropTargetFrom(node, "tabs")).toBe("pane-2");
  });
});

describe("placing a model in the loadout", () => {
  test("a new model dropped past the last filled slot takes the first free one", () => {
    expect(placeInLoadout(["a"], "b", 3)).toEqual(["a", "b"]);
  });

  test("a model dropped on a filled slot takes it and moves the rest along", () => {
    expect(placeInLoadout(["a", "b", "c"], "x", 1)).toEqual(["a", "x", "b", "c"]);
  });

  test("a model already in the loadout moves rather than appearing twice", () => {
    expect(placeInLoadout(["a", "b", "c", "d"], "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(placeInLoadout(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
  });

  test("a full loadout keeps to its slots", () => {
    const full = ["a", "b", "c", "d", "e"];
    expect(placeInLoadout(full, "x", 0)).toEqual(["x", "a", "b", "c", "d"]);
    expect(placeInLoadout(full, "x", LOADOUT_SLOTS - 1)).toHaveLength(LOADOUT_SLOTS);
  });

  test("a position before the first slot is the first slot", () => {
    expect(placeInLoadout(["a", "b"], "b", -1)).toEqual(["b", "a"]);
  });
});
