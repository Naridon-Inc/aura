// What this pins: leaving split view keeps your tabs.
//
// Every leaf in the split tree owns its own tab list and draws its own tab
// strip, so the tree is not decoration over one flat list of tabs — it is
// where the tabs live. "Leave split view" used to set the tree to null, which
// reads as "no layout" and renders as "the tab in the other pane is gone".
// `removeSplitPane` already learned this lesson once and documents it; these
// tests are the same lesson for the one path that had not.

import { describe, expect, it } from "bun:test";

import {
  makeLeaf,
  samePaneRef,
  treeCollapse,
  type WorkPaneRef,
  type WorkSplitTree,
} from "./editorStore";

const agent = (id: string): WorkPaneRef => ({ kind: "agent", id });
const file = (path: string): WorkPaneRef => ({ kind: "file", path });

function row(...children: WorkSplitTree[]): WorkSplitTree {
  return { kind: "split", direction: "row", children };
}
function column(...children: WorkSplitTree[]): WorkSplitTree {
  return { kind: "split", direction: "column", children };
}

const ids = (refs: WorkPaneRef[]) =>
  refs.map((r) => (r.kind === "file" ? r.path : r.id));

describe("folding a split back into one pane", () => {
  // The user's report, exactly: two panes, Claude Code on the left and Codex
  // on the right, "leave split view" on one of them — and Codex disappeared
  // instead of becoming a tab.
  it("keeps the other pane's tab instead of dropping it", () => {
    const tree = row(makeLeaf([agent("claude")]), makeLeaf([agent("codex")]));
    const leaf = treeCollapse(tree, agent("claude"));

    expect(leaf.kind).toBe("leaf");
    expect(ids(leaf.tabs)).toEqual(["claude", "codex"]);
    expect(samePaneRef(leaf.tabs[leaf.activeIndex], agent("claude"))).toBe(true);
  });

  it("focuses whichever tab asked to leave", () => {
    const tree = row(makeLeaf([agent("claude")]), makeLeaf([agent("codex")]));
    const leaf = treeCollapse(tree, agent("codex"));
    expect(samePaneRef(leaf.tabs[leaf.activeIndex], agent("codex"))).toBe(true);
  });

  // A pane that was carrying several tabs loses none of them, including the
  // ones that were not on top.
  it("brings every tab from every pane, not just the visible ones", () => {
    const tree = row(
      makeLeaf([agent("claude"), file("src/a.ts")], 1),
      makeLeaf([agent("codex"), file("src/b.ts"), agent("gemini")], 2),
    );
    const leaf = treeCollapse(tree, file("src/a.ts"));
    expect(ids(leaf.tabs)).toEqual([
      "claude",
      "src/a.ts",
      "codex",
      "src/b.ts",
      "gemini",
    ]);
    expect(leaf.activeIndex).toBe(1);
  });

  // Tabs arrive in the order they were on screen, left to right and top to
  // bottom, because a tab strip that reshuffles is a tab strip you have to
  // re-read.
  it("orders the tabs the way the panes were laid out", () => {
    const tree = row(
      makeLeaf([agent("left")]),
      column(makeLeaf([agent("mid-top")]), makeLeaf([agent("mid-bottom")])),
      makeLeaf([agent("right")]),
    );
    const leaf = treeCollapse(tree, agent("mid-bottom"));
    expect(ids(leaf.tabs)).toEqual(["left", "mid-top", "mid-bottom", "right"]);
    expect(samePaneRef(leaf.tabs[leaf.activeIndex], agent("mid-bottom"))).toBe(
      true,
    );
  });

  // The surviving pane keeps the pane id of the pane the user was in. It is
  // the React key for the whole pane subtree, so a fresh id would tear down
  // and remount a live terminal to say "this is now the only pane".
  it("keeps the asking pane's identity rather than minting a new one", () => {
    const left = makeLeaf([agent("claude")]);
    const right = makeLeaf([agent("codex")]);
    expect(treeCollapse(row(left, right), agent("codex")).paneId).toBe(
      right.paneId,
    );
    expect(treeCollapse(row(left, right), agent("claude")).paneId).toBe(
      left.paneId,
    );
  });

  it("falls back to the first pane when the named tab is not in the tree", () => {
    const left = makeLeaf([agent("claude")]);
    const tree = row(left, makeLeaf([agent("codex")]));
    const leaf = treeCollapse(tree, agent("never-opened"));
    expect(leaf.paneId).toBe(left.paneId);
    expect(ids(leaf.tabs)).toEqual(["claude", "codex"]);
    expect(samePaneRef(leaf.tabs[leaf.activeIndex], agent("claude"))).toBe(true);
  });

  it("keeps the focused tab focused when nothing is named", () => {
    const tree = row(
      makeLeaf([agent("claude"), agent("gemini")], 1),
      makeLeaf([agent("codex")]),
    );
    const leaf = treeCollapse(tree);
    expect(samePaneRef(leaf.tabs[leaf.activeIndex], agent("gemini"))).toBe(true);
  });

  // Already one pane: hand back the very same leaf, so the store can tell
  // that nothing changed and skip a re-render of every open surface.
  it("hands back the same leaf when there is only one pane", () => {
    const only = makeLeaf([agent("claude"), agent("codex")], 1);
    expect(treeCollapse(only, agent("claude"))).toBe(only);
    expect(treeCollapse(only)).toBe(only);
  });

  // A ref is meant to live in one pane at a time. If one ever did not, two
  // tabs for one session is a worse outcome than silently keeping the first.
  it("refuses to produce two tabs for the same thing", () => {
    const tree = row(makeLeaf([agent("claude")]), makeLeaf([agent("claude")]));
    expect(ids(treeCollapse(tree, agent("claude")).tabs)).toEqual(["claude"]);
  });
});
