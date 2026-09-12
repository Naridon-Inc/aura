// What these pin: the two diff preferences are persisted under their own keys,
// default the way the product promises (side-by-side, editable), never crash
// without storage, and tell every open pane the moment one toggle flips.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  getDiffView,
  getEditableDiffs,
  setDiffView,
  setEditableDiffs,
  subscribeDiffView,
  subscribeEditableDiffs,
} from "./diffViewPref";

type Listener = (e: Event) => void;

// bun's runner has no DOM. The module reads storage through try/catch and
// broadcasts through `window`, so both are stood up here — without them every
// read would fall to the default and the tests would pass while proving
// nothing about persistence.
function installDom() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const listeners = new Map<string, Set<Listener>>();
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (e: Event) => {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
  };
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !== "function") {
    (globalThis as { CustomEvent?: unknown }).CustomEvent = class<T> extends Event {
      detail: T;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail as T;
      }
    };
  }
}

beforeEach(() => {
  installDom();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

describe("split / unified", () => {
  it("defaults to side-by-side and remembers a flip", () => {
    expect(getDiffView()).toBe("split");
    setDiffView("unified");
    expect(getDiffView()).toBe("unified");
    expect(localStorage.getItem("aura.git.diffView")).toBe("unified");
  });

  it("falls back to the default on a stray stored value", () => {
    localStorage.setItem("aura.git.diffView", "sideways");
    expect(getDiffView()).toBe("split");
  });

  it("tells subscribers once per real change", () => {
    const seen: string[] = [];
    const off = subscribeDiffView((v) => seen.push(v));
    setDiffView("unified");
    setDiffView("unified");
    setDiffView("split");
    off();
    setDiffView("unified");
    expect(seen).toEqual(["unified", "split"]);
  });
});

describe("edit in diff", () => {
  it("is on by default, matching the product promise", () => {
    expect(getEditableDiffs()).toBe(true);
  });

  it("persists read-only under its own key and reads it back", () => {
    setEditableDiffs(false);
    expect(getEditableDiffs()).toBe(false);
    expect(localStorage.getItem("aura.git.editableDiffs")).toBe("0");
    // The other preference is untouched by this one.
    expect(getDiffView()).toBe("split");
    setEditableDiffs(true);
    expect(localStorage.getItem("aura.git.editableDiffs")).toBe("1");
  });

  it("treats anything but an explicit off as on", () => {
    localStorage.setItem("aura.git.editableDiffs", "maybe");
    expect(getEditableDiffs()).toBe(true);
    localStorage.setItem("aura.git.editableDiffs", "false");
    expect(getEditableDiffs()).toBe(false);
  });

  it("broadcasts each real flip and stops after unsubscribe", () => {
    const seen: boolean[] = [];
    const off = subscribeEditableDiffs((on) => seen.push(on));
    setEditableDiffs(false);
    setEditableDiffs(false);
    setEditableDiffs(true);
    off();
    setEditableDiffs(false);
    expect(seen).toEqual([false, true]);
  });

  it("follows a change made in another window", () => {
    const seen: boolean[] = [];
    subscribeEditableDiffs((on) => seen.push(on));
    const ev = new Event("storage") as Event & { key: string; newValue: string };
    ev.key = "aura.git.editableDiffs";
    ev.newValue = "0";
    window.dispatchEvent(ev);
    expect(seen).toEqual([false]);
  });

  it("survives a missing storage without throwing", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(getEditableDiffs()).toBe(true);
    expect(() => setEditableDiffs(false)).not.toThrow();
  });
});
