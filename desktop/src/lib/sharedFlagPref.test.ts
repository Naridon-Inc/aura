import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sharedFlagPref } from "./sharedFlagPref";

// A tiny window + localStorage, enough for the pref to store and broadcast.
// Both are put back afterwards: other test files share this process.
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
const saved = { localStorage: g.localStorage, window: g.window };

describe("sharedFlagPref", () => {
  beforeAll(() => {
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    g.window = new EventTarget();
  });
  afterAll(() => {
    g.localStorage = saved.localStorage;
    g.window = saved.window;
  });
  beforeEach(() => store.clear());

  test("reads the fallback until something is stored", () => {
    expect(sharedFlagPref("k.a", "e.a").get()).toBe(false);
    expect(sharedFlagPref("k.a", "e.a", true).get()).toBe(true);
  });

  test("a set is stored and heard by every subscriber", () => {
    const pref = sharedFlagPref("k.b", "e.b");
    const heard: boolean[] = [];
    const stop = pref.subscribe((on) => heard.push(on));
    pref.set(true);
    expect(pref.get()).toBe(true);
    expect(store.get("k.b")).toBe("1");
    expect(heard).toEqual([true]);
    stop();
    pref.set(false);
    expect(heard).toEqual([true]);
  });

  test("setting the value it already has tells nobody", () => {
    const pref = sharedFlagPref("k.c", "e.c");
    const heard: boolean[] = [];
    pref.subscribe((on) => heard.push(on));
    pref.set(false);
    expect(heard).toEqual([]);
  });
});
