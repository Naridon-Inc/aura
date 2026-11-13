// Run with: bun test src/lib/workTabDrag.test.ts
//
// Tabs, terminals and panes are carried with pointer drags whose sources and
// landing places live in different components. These pin what each landing
// place takes and what a drop there does — the part that used to be spread
// across MIME checks in every `onDragOver` and `onDrop`.

import { describe, expect, test } from "bun:test";
import { paneDropIndex, tabDropAction, tabDropKey, type TabDrag } from "./workTabDrag";

const editorTab: TabDrag = { from: { paneId: "p1", index: 2 } };
const editorTerminal: TabDrag = { from: { paneId: "p1", index: 0 }, termId: "t9" };
const panelRow: TabDrag = { termId: "t3" };

describe("a pane's tab strip", () => {
  test("takes a tab from another pane and moves it there", () => {
    expect(tabDropAction(editorTab, tabDropKey.pane("p2"))).toEqual({
      kind: "move",
      srcPaneId: "p1",
      srcIndex: 2,
      dstPaneId: "p2",
    });
  });

  test("ignores a tab dropped back on its own pane", () => {
    expect(tabDropAction(editorTab, tabDropKey.pane("p1"))).toBeUndefined();
  });

  test("ignores a terminal-panel row, which has no pane to leave", () => {
    expect(tabDropAction(panelRow, tabDropKey.pane("p2"))).toBeUndefined();
  });
});

describe("the terminal panel", () => {
  test("a group takes any terminal and tiles it into its split", () => {
    expect(tabDropAction(panelRow, tabDropKey.group("g1"))).toEqual({ kind: "merge", termId: "t3", groupId: "g1" });
    expect(tabDropAction(editorTerminal, tabDropKey.group("g1"))).toEqual({
      kind: "merge",
      termId: "t9",
      groupId: "g1",
    });
  });

  test("its empty space takes a terminal back as a group of its own", () => {
    expect(tabDropAction(editorTerminal, tabDropKey.panel)).toEqual({ kind: "demote", termId: "t9" });
    expect(tabDropAction(panelRow, tabDropKey.panel)).toEqual({ kind: "demote", termId: "t3" });
  });

  test("does not take a tab that is not a terminal", () => {
    expect(tabDropAction(editorTab, tabDropKey.group("g1"))).toBeUndefined();
    expect(tabDropAction(editorTab, tabDropKey.panel)).toBeUndefined();
  });
});

describe("names", () => {
  test("a pane and a group with the same id are different places", () => {
    expect(tabDropKey.pane("x")).not.toBe(tabDropKey.group("x"));
  });

  test("an id may itself hold a colon", () => {
    expect(tabDropAction(editorTab, tabDropKey.pane("leaf:7"))).toMatchObject({ dstPaneId: "leaf:7" });
  });

  test("nothing carried, nothing under the pointer, or an unknown place does nothing", () => {
    expect(tabDropAction(undefined, tabDropKey.panel)).toBeUndefined();
    expect(tabDropAction(editorTerminal, undefined)).toBeUndefined();
    expect(tabDropAction(editorTerminal, "elsewhere:1")).toBeUndefined();
    expect(tabDropAction(editorTerminal, "pane:")).toBeUndefined();
  });
});

describe("a pane carried within the split", () => {
  test("lands on the pane it is dropped on", () => {
    expect(paneDropIndex(0, "2")).toBe(2);
  });

  test("stays put when dropped on itself or nowhere", () => {
    expect(paneDropIndex(1, "1")).toBeUndefined();
    expect(paneDropIndex(1, undefined)).toBeUndefined();
    expect(paneDropIndex(undefined, "1")).toBeUndefined();
    expect(paneDropIndex(1, "pane:p2")).toBeUndefined();
  });
});
