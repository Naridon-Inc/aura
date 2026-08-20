// Close two of three tabs and the third is still there — with its tab row.
//
//   bun test
//
// Reported twice: "if there's 3 tabs and i close two it immediately hides the
// last one as well."
//
// `closeTabInPane` carried a branch older than the strip it was written for.
// When the close left exactly one "flat-capable" tab — file / agent / terminal
// / manager / plan — it set `splitLayout: null` and copied the survivor into
// the matching `active*` flag, handing it to the flat tab strip that used to
// draw those kinds.
//
// That strip was deleted ("delete the second tab strip — 2,106 lines, twelve
// bespoke rows"), and the invariant it left behind is one sentence: a tab
// always has a tree, because PerPaneTabStrip is the only thing that draws a
// tab row and it renders only inside WorkSurface's `splitLayout && splitOk`
// branch. That commit closed the two doors it knew about — both workspace
// restore paths now seed a tree — and left this one open.
//
// So the collapse stopped handing the tab over and started taking its tab row
// away. Three tabs, close one: two left, layout stands. Close another: one
// left, layout nulled, and the surviving tab drops onto a fallback whose top
// row is a bare chrome band — the window's edge with no tabs in it. Which is
// exactly the shape of the report: it takes two closes, not one, and it is
// the LAST tab that goes.
//
// The body's fate depends on what survived. A file / agent / terminal /
// manager still renders, tabless. A `plan` is worse: its flat path went with
// the strip, so the surface falls through to WorkSurfaceEmpty and the tab and
// its contents both vanish.
//
// Two things are pinned here.
//
// 1. THE BEHAVIOUR, driven through the real store. Three tabs in, two closes,
//    and the layout still holds the tab nobody closed. Every route into it:
//    the tab's own ✕, "Close other tabs" (which loops through the same
//    function), and "Close pane", which had its own copy of the collapse.
//
// 2. THE REASON A NULL LAYOUT MEANS AN INVISIBLE TAB — that one tab row, and
//    that it only renders when a layout exists. Without this half, (1) is a
//    test about a field name.

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  makeLeaf,
  useEditorStore,
  type WorkPaneRef,
  type WorkSplitTree,
} from "../src/lib/editorStore";
import { readSrc } from "./support/code";

/** The store's action surface. `useEditorStore` is a hook, so it is read
 *  through a one-shot SSR render rather than mocked — the functions it hands
 *  back are the module-level ones the app calls. Re-read it after every
 *  action: the returned object snapshots `state` at call time. */
function store() {
  let captured: ReturnType<typeof useEditorStore> | null = null;
  renderToStaticMarkup(
    createElement(function ReadStore() {
      captured = useEditorStore();
      return null;
    }),
  );
  if (!captured) throw new Error("store was never read");
  return captured as ReturnType<typeof useEditorStore>;
}

const file = (path: string): WorkPaneRef => ({ kind: "file", path });

/** Seed the surface with one pane holding `tabs`, first one focused. */
function openTabs(tabs: WorkPaneRef[]) {
  const leaf = makeLeaf(tabs, 0);
  store().setSplitLayoutTree(leaf);
  return leaf;
}

/** The tab list of the one leaf a layout has, or null when there is none. */
function stripTabs(layout: WorkSplitTree | null): WorkPaneRef[] | null {
  if (!layout || layout.kind !== "leaf") return null;
  return layout.tabs;
}

describe("closing tabs never closes the one you kept", () => {
  test("three tabs, two closes, and the third still has a tree", () => {
    const leaf = openTabs([file("/a.ts"), file("/b.ts"), file("/c.ts")]);

    store().closeTabInPane(leaf.paneId, 0);
    expect(stripTabs(store().splitLayout)).toEqual([file("/b.ts"), file("/c.ts")]);

    // The close that used to null the layout out from under the survivor.
    store().closeTabInPane(leaf.paneId, 0);
    expect(store().splitLayout).not.toBeNull();
    expect(stripTabs(store().splitLayout)).toEqual([file("/c.ts")]);
  });

  test("and the survivor is the focused tab of that pane", () => {
    // A tree whose activeIndex points past its tabs renders nothing, which
    // would be the same disappearance by another route.
    const leaf = openTabs([file("/a.ts"), file("/b.ts"), file("/c.ts")]);
    store().closeTabInPane(leaf.paneId, 0);
    store().closeTabInPane(leaf.paneId, 0);
    const layout = store().splitLayout;
    expect(layout?.kind).toBe("leaf");
    if (layout?.kind !== "leaf") throw new Error("expected one leaf");
    expect(layout.tabs[layout.activeIndex]).toEqual(file("/c.ts"));
  });

  test("only closing the LAST tab clears the layout", () => {
    const leaf = openTabs([file("/a.ts"), file("/b.ts"), file("/c.ts")]);
    store().closeTabInPane(leaf.paneId, 0);
    store().closeTabInPane(leaf.paneId, 0);
    store().closeTabInPane(leaf.paneId, 0);
    // Nothing open is the one state that has no tab row to draw, and the
    // empty surface underneath it is the launcher.
    expect(store().splitLayout).toBeNull();
  });

  test("'Close other tabs' leaves a strip behind, not a bare band", () => {
    // closeOtherTabsInPane closes through closeTabInPane in a loop, so on a
    // three-tab strip it walked straight into the collapse on its second
    // pass and stopped — one tab open, no layout, no tab row.
    const leaf = openTabs([file("/a.ts"), file("/b.ts"), file("/c.ts")]);
    store().closeOtherTabsInPane(leaf.paneId, 2);
    expect(store().splitLayout).not.toBeNull();
    expect(stripTabs(store().splitLayout)).toEqual([file("/c.ts")]);
  });

  test("a kind with no flat surface at all survives the same way", () => {
    // `plan` was the worst survivor: the flat plan path was deleted with the
    // strip, so a nulled layout took the tab AND its body, leaving the empty
    // surface. Same close, same assertion — the difference was only in how
    // loudly it failed.
    const plan: WorkPaneRef = { kind: "plan", id: "plan-1" };
    const leaf = openTabs([file("/a.ts"), file("/b.ts"), plan]);
    store().closeTabInPane(leaf.paneId, 0);
    store().closeTabInPane(leaf.paneId, 0);
    expect(stripTabs(store().splitLayout)).toEqual([plan]);
  });

  test("closing a pane hands over the survivor's whole tab row", () => {
    // removeSplitPane carried its own copy of the collapse, and it cost more:
    // the leaf it nulled away could be holding any number of tabs, so closing
    // one pane of two emptied the other pane's strip.
    const left = makeLeaf([file("/a.ts")], 0);
    const right = makeLeaf([file("/b.ts"), file("/c.ts")], 0);
    const tree: WorkSplitTree = {
      kind: "split",
      direction: "row",
      children: [left, right],
    };
    store().setSplitLayoutTree(tree);
    store().removeSplitPane(0);
    expect(store().splitLayout).not.toBeNull();
    expect(stripTabs(store().splitLayout)).toEqual([file("/b.ts"), file("/c.ts")]);
  });
});

describe("why a nulled layout is an invisible tab", () => {
  test("WorkSurface draws exactly one tab row", async () => {
    // Two drawings of this row is the defect the strip deletion ended. If a
    // second one comes back, the store fix above stops being the thing
    // keeping the tab on screen and this file stops being about the bug.
    const src = await readSrc("components/WorkSurface.tsx");
    expect((src.match(/<PerPaneTabStrip/g) ?? []).length).toBe(1);
  });

  test("and it renders only where a layout exists", async () => {
    const src = await readSrc("components/WorkSurface.tsx");
    const splitPath = src.indexOf("if (splitLayout && splitOk) {");
    const strip = src.indexOf("<PerPaneTabStrip");
    const stripComponent = src.indexOf("function PerPaneTabStrip");
    expect(splitPath).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(splitPath);
    // The render site is inside that branch, well before the component's own
    // definition further down the file.
    expect(strip).toBeLessThan(stripComponent);
  });

  test("the fallbacks below it carry a chrome band with no tabs in it", async () => {
    // This is what the surviving tab used to land on: the top edge of the
    // window, the shell's chrome at either end, and a drag region between.
    const src = await readSrc("components/WorkSurface.tsx");
    const band = src.slice(
      src.indexOf("const chromeBand = "),
      src.indexOf("if (store.activePrDetail)"),
    );
    expect(band.length).toBeGreaterThan(0);
    expect(band).toContain("data-tauri-drag-region");
    expect(band).not.toContain("TabStrip");
  });

  test("so closeTabInPane clears the layout on one exit only", async () => {
    // The emptied-tree exit. Any second `splitLayout: null` in this function
    // is a tab left on screen with nothing to draw its row.
    const src = await readSrc("lib/editorStore.ts");
    const body = src.slice(
      src.indexOf("function closeTabInPane"),
      src.indexOf("function closeOtherTabsInPane"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect((body.match(/splitLayout: null/g) ?? []).length).toBe(1);
    expect(body).toContain("const next = treeRemove(tree, ref);\n  if (!next) {");
  });

  test("and removeSplitPane does too", async () => {
    const src = await readSrc("lib/editorStore.ts");
    const body = src.slice(
      src.indexOf("function removeSplitPane"),
      src.indexOf("function setSplitDirection"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect((body.match(/splitLayout: null/g) ?? []).length).toBe(1);
  });
});
