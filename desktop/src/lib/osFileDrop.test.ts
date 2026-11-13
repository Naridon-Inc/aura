// Run with: bun test src/lib/osFileDrop.test.ts
//
// The desktop app's web view never delivers an HTML5 `drop` for a Files row,
// so a row released on one of the tree's folders is landed by the window's
// drop router from the point the release is reported at. This pins which
// folder that point moves the drag into.

import { afterEach, describe, expect, test } from "bun:test";
import {
  beginInAppFileDrag,
  installInAppFileDropRouter,
  moveDirFrom,
  OS_FILE_DROP_COMPOSER,
  type MoveNode,
} from "./osFileDrop";

/** An element chain, innermost first: `[child, parent, …]`. */
function chain(...data: Array<Record<string, string> | undefined>): MoveNode {
  let parent: MoveNode | null = null;
  for (const dataset of data.slice().reverse()) parent = { dataset, parentElement: parent };
  return parent as MoveNode;
}

const any = () => true;

describe("the folder a released Files row moves into", () => {
  test("is the folder row under the pointer, from any part of the row", () => {
    expect(moveDirFrom(chain({ fileMoveDir: "/repo/src" }), any)).toBe("/repo/src");
    expect(moveDirFrom(chain(undefined, undefined, { fileMoveDir: "/repo/src" }, undefined), any)).toBe("/repo/src");
  });

  test("is none over anything that is not a folder row", () => {
    expect(moveDirFrom(chain(undefined, { osDrop: "terminal" }), any)).toBeNull();
    expect(moveDirFrom(null, any)).toBeNull();
  });

  test("is none over a folder that refuses the drag, never one further out", () => {
    const refuses = (dir: string) => dir !== "/repo/src";
    expect(moveDirFrom(chain({ fileMoveDir: "/repo/src" }, { fileMoveDir: "/repo" }), refuses)).toBeNull();
  });

  test("asks the drag about the folder it is over", () => {
    const asked: string[] = [];
    moveDirFrom(chain(undefined, { fileMoveDir: "/repo/docs" }), (dir) => (asked.push(dir), true));
    expect(asked).toEqual(["/repo/docs"]);
  });
});

describe("a Files row's drag that ends over the chat box", () => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const had = { window: g.window, document: g.document };
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    g.window = had.window;
    g.document = had.document;
  });

  /** The page as the router sees it: one chat box under every point. */
  function page(): string[][] {
    const host = {
      getAttribute: (k: string) =>
        ({ "data-os-drop": "composer", "data-os-drop-id": "c1" } as Record<string, string>)[k] ?? null,
    };
    const win = new EventTarget();
    g.window = win;
    g.document = { elementFromPoint: () => ({ closest: () => host }) };
    const landed: string[][] = [];
    win.addEventListener(OS_FILE_DROP_COMPOSER, (e) => landed.push((e as CustomEvent).detail.paths));
    off = installInAppFileDropRouter();
    return landed;
  }

  /** The row's `dragend`, released at a point, with how the drag ended. */
  function dragEnd(dropEffect: string): Event {
    return Object.assign(new Event("dragend"), { clientX: 40, clientY: 40, dataTransfer: { dropEffect } });
  }

  test("lands nothing when the drag was cancelled", () => {
    const landed = page();
    beginInAppFileDrag(["/repo/src/a.ts"]);
    (g.window as EventTarget).dispatchEvent(dragEnd("none"));
    expect(landed).toEqual([]);
  });

  test("hands the path to the chat box when the drag was dropped there", () => {
    const landed = page();
    beginInAppFileDrag(["/repo/src/a.ts"]);
    (g.window as EventTarget).dispatchEvent(dragEnd("copy"));
    expect(landed).toEqual([["/repo/src/a.ts"]]);
  });
});
