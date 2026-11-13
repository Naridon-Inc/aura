import { describe, expect, test } from "bun:test";

import {
  CLOSE_TILE,
  FILE_MANAGER,
  byRecentUse,
  captionInsets,
  createSwitcherStore,
  fileManagerName,
  readRecent,
  recordUse,
  releasesSwitcher,
  switcherEntries,
  tilesThatFit,
  writeRecent,
} from "./appSwitcher";

const apps = [
  { id: "vscode", name: "VS Code", available: true },
  { id: "cursor", name: "Cursor", available: true },
  { id: "zed", name: "Zed", available: false },
  { id: "default", name: "System default", available: true },
];

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    schedule: (fn: () => void) => {
      pending.set(++next, fn);
      return next;
    },
    cancel: (h: unknown) => void pending.delete(h as number),
    fire: () => {
      for (const [h, fn] of [...pending]) {
        pending.delete(h);
        fn();
      }
    },
    count: () => pending.size,
  };
}

describe("which apps, in what order", () => {
  test("installed editors, then the file manager, then Close; no system default", () => {
    const ids = switcherEntries(apps, [], 1400, "Finder").map((e) => e.id);
    expect(ids).toEqual(["vscode", "cursor", FILE_MANAGER, CLOSE_TILE]);
  });

  test("the app used last leads, so a quick tap reopens it", () => {
    const ids = switcherEntries(apps, ["finder", "cursor"], 1400, "Finder").map((e) => e.id);
    expect(ids).toEqual([FILE_MANAGER, "cursor", "vscode", CLOSE_TILE]);
  });

  test("a recent app that is gone is skipped", () => {
    expect(byRecentUse([{ id: "a", name: "A" }], ["zed", "a"]).map((e) => e.id)).toEqual(["a"]);
  });

  test("a narrow window keeps Close and drops the apps that don't fit", () => {
    expect(tilesThatFit(400)).toBe(2);
    expect(switcherEntries(apps, [], 400, "Finder").map((e) => e.id)).toEqual(["vscode", CLOSE_TILE]);
    expect(tilesThatFit(10)).toBe(1);
  });

  test("using an app moves it to the front once", () => {
    expect(recordUse(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  test("the file manager is named the way the computer names it", () => {
    expect(fileManagerName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Finder");
    expect(fileManagerName("Mozilla/5.0 (Windows NT 10.0)")).toBe("File Explorer");
    expect(fileManagerName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Files");
  });

  test("the recent list survives a bad store", () => {
    expect(readRecent({ getItem: () => "{oops" })).toEqual([]);
    expect(readRecent({ getItem: () => JSON.stringify([1, 2]) })).toEqual([]);
    let saved = "";
    writeRecent(["a"], { setItem: (_k, v) => void (saved = v) });
    expect(readRecent({ getItem: () => saved })).toEqual(["a"]);
    writeRecent(["a"], {
      setItem: () => {
        throw new Error("full");
      },
    });
  });
});

describe("holding the chord", () => {
  test("letting go of ⌘ or ⌥ opens; letting go of ⇧ or O does not", () => {
    expect(releasesSwitcher({ type: "keyup", key: "Meta" })).toBe(true);
    expect(releasesSwitcher({ type: "keyup", key: "Alt" })).toBe(true);
    expect(releasesSwitcher({ type: "keyup", key: "Control" })).toBe(true);
    expect(releasesSwitcher({ type: "keyup", key: "Shift" })).toBe(false);
    expect(releasesSwitcher({ type: "keyup", key: "o" })).toBe(false);
    expect(releasesSwitcher({ type: "keydown", key: "Meta" })).toBe(false);
  });

  test("the panel draws after the delay, or at once when you step", () => {
    const t = fakeTimers();
    const s = createSwitcherStore(t);
    const entries = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: CLOSE_TILE, name: "Close" },
    ];
    s.activate(entries, "/w");
    expect(s.get()).toMatchObject({ active: true, ready: false, selected: 0, path: "/w" });
    t.fire();
    expect(s.get().ready).toBe(true);

    s.deactivate();
    s.activate(entries, "/w");
    s.forward();
    expect(s.get()).toMatchObject({ ready: true, selected: 1 });
    expect(t.count()).toBe(0);
  });

  test("stepping wraps both ways", () => {
    const s = createSwitcherStore(fakeTimers());
    s.activate(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: CLOSE_TILE, name: "Close" },
      ],
      "/w",
    );
    s.backward();
    expect(s.selectedEntry()?.id).toBe(CLOSE_TILE);
    s.forward();
    expect(s.selectedEntry()?.id).toBe("a");
  });

  test("closing clears it, and a late reveal does not bring it back", () => {
    const t = fakeTimers();
    const s = createSwitcherStore(t);
    s.activate([{ id: "a", name: "A" }], "/w");
    s.deactivate();
    t.fire();
    expect(s.get()).toMatchObject({ active: false, ready: false, entries: [], path: null });
    s.forward();
    expect(s.get().selected).toBe(0);
  });

  test("the name sits under the selected tile", () => {
    expect(captionInsets(0, 3)).toEqual({ left: 0, right: 220 });
    expect(captionInsets(1, 3)).toEqual({ left: 0, right: 0 });
    expect(captionInsets(2, 3)).toEqual({ left: 220, right: 0 });
  });
});
