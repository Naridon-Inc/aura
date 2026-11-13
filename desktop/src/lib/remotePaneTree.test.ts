import { describe, expect, it } from "bun:test";

import {
  addPaneBeside,
  paneCount,
  paneHolds,
  paneLeaf,
  paneTabIds,
  parsePaneTree,
  prunePanes,
  removePane,
  type RemotePaneTree,
} from "./remotePaneTree";

const all = () => true;

describe("addPaneBeside", () => {
  it("turns one pane into a split of two", () => {
    const tree = addPaneBeside(paneLeaf("claude"), "claude", "build", "row");
    expect(tree).toEqual({
      kind: "split",
      direction: "row",
      children: [paneLeaf("claude"), paneLeaf("build")],
    });
  });

  it("lands the new pane immediately after the one you were in", () => {
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "a", "c", "row");
    // Beside `a` means next to `a`, not at the end of the row.
    expect(paneTabIds(tree)).toEqual(["a", "c", "b"]);
  });

  it("shares one axis evenly rather than nesting a half", () => {
    // Three asked for one at a time across a row are thirds. Nesting would
    // make the first pane half the width and the other two quarters.
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "b", "c", "row");
    expect(tree).toEqual({
      kind: "split",
      direction: "row",
      children: [paneLeaf("a"), paneLeaf("b"), paneLeaf("c")],
    });
  });

  it("nests when the direction changes", () => {
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "b", "c", "column");
    expect(tree).toEqual({
      kind: "split",
      direction: "row",
      children: [
        paneLeaf("a"),
        { kind: "split", direction: "column", children: [paneLeaf("b"), paneLeaf("c")] },
      ],
    });
  });

  it("refuses to draw the same tab twice", () => {
    // Two panes of one session would be two clients on the same tmux pane,
    // fighting each other for the keyboard.
    const tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    expect(addPaneBeside(tree, "a", "b", "column")).toBe(tree);
    expect(addPaneBeside(tree, "a", "a", "row")).toBe(tree);
  });

  it("changes nothing when the pane to sit beside is not on screen", () => {
    const tree = paneLeaf("a");
    expect(addPaneBeside(tree, "somewhere-else", "b", "row")).toBe(tree);
  });
});

describe("removePane", () => {
  it("leaves the remaining pane as a plain leaf", () => {
    const tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    expect(removePane(tree, "b")).toEqual(paneLeaf("a"));
  });

  it("keeps the others where they were", () => {
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "b", "c", "row");
    expect(paneTabIds(removePane(tree, "b")!)).toEqual(["a", "c"]);
  });

  it("collapses a nested split that is down to one pane", () => {
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "b", "c", "column");
    // Dropping `c` must not leave `b` wearing a column split with a divider
    // to nowhere.
    expect(removePane(tree, "c")).toEqual({
      kind: "split",
      direction: "row",
      children: [paneLeaf("a"), paneLeaf("b")],
    });
  });

  it("is null when the last pane goes", () => {
    expect(removePane(paneLeaf("a"), "a")).toBeNull();
  });

  it("changes nothing for a tab that is not in the layout", () => {
    const tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    expect(paneTabIds(removePane(tree, "zzz")!)).toEqual(["a", "b"]);
  });
});

describe("prunePanes", () => {
  it("drops every pane whose tab is gone", () => {
    let tree = addPaneBeside(paneLeaf("a"), "a", "b", "row");
    tree = addPaneBeside(tree, "b", "c", "row");
    const kept = prunePanes(tree, (id) => id === "c");
    expect(kept).toEqual(paneLeaf("c"));
  });
});

describe("parsePaneTree", () => {
  it("reads a split back", () => {
    const stored = {
      kind: "split",
      direction: "column",
      children: [{ kind: "leaf", tabId: "a" }, { kind: "leaf", tabId: "b" }],
    };
    expect(parsePaneTree(stored, all)).toEqual({
      kind: "split",
      direction: "column",
      children: [paneLeaf("a"), paneLeaf("b")],
    });
  });

  it("drops leaves naming tabs the strip no longer has", () => {
    const stored = {
      kind: "split",
      direction: "row",
      children: [
        { kind: "leaf", tabId: "still-open" },
        { kind: "leaf", tabId: "closed-yesterday" },
        { kind: "leaf", tabId: "also-open" },
      ],
    };
    const tree = parsePaneTree(stored, (id) => id !== "closed-yesterday");
    expect(paneTabIds(tree!)).toEqual(["still-open", "also-open"]);
  });

  it("is null once a layout is down to one pane", () => {
    // A body showing one tab is the plain body — there is nothing to arrange.
    const stored = {
      kind: "split",
      direction: "row",
      children: [{ kind: "leaf", tabId: "a" }, { kind: "leaf", tabId: "gone" }],
    };
    expect(parsePaneTree(stored, (id) => id === "a")).toBeNull();
    expect(parsePaneTree({ kind: "leaf", tabId: "a" }, all)).toBeNull();
  });

  it("keeps the first place of a tab a blob names twice", () => {
    const stored = {
      kind: "split",
      direction: "row",
      children: [
        { kind: "leaf", tabId: "a" },
        { kind: "leaf", tabId: "b" },
        { kind: "leaf", tabId: "a" },
      ],
    };
    expect(paneTabIds(parsePaneTree(stored, all)!)).toEqual(["a", "b"]);
  });

  it("refuses nonsense instead of handing the renderer a pane with no tab", () => {
    expect(parsePaneTree(null, all)).toBeNull();
    expect(parsePaneTree({ kind: "leaf" }, all)).toBeNull();
    expect(parsePaneTree({ kind: "split", direction: "sideways", children: [] }, all)).toBeNull();
    expect(
      parsePaneTree({ kind: "split", direction: "row", children: "a,b" }, all),
    ).toBeNull();
    // A split whose children are all junk is not a split.
    expect(
      parsePaneTree({ kind: "split", direction: "row", children: [1, "two", {}] }, all),
    ).toBeNull();
  });
});

describe("paneCount / paneHolds", () => {
  it("counts the panes a body will draw", () => {
    const tree: RemotePaneTree = {
      kind: "split",
      direction: "row",
      children: [
        paneLeaf("a"),
        { kind: "split", direction: "column", children: [paneLeaf("b"), paneLeaf("c")] },
      ],
    };
    expect(paneCount(tree)).toBe(3);
    expect(paneHolds(tree, "c")).toBe(true);
    expect(paneHolds(tree, "d")).toBe(false);
  });
});
