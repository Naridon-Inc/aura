// What these pin: a viewed mark holds while the change is the one that was
// marked, turns to "changed" when the patch moves on, reads back from storage,
// and is dropped after thirty days.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  VIEWED_KEY,
  VIEWED_TTL_MS,
  getViewed,
  markViewed,
  patchSig,
  resetViewedCache,
  subscribeViewed,
  unmarkViewed,
  viewedState,
  viewedStateBySig,
} from "./viewedFiles";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  resetViewedCache();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  resetViewedCache();
});

const WS = "/repo";
const P1 = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n";
const P2 = "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n-a\n+b\n+d\n c\n";

describe("viewed files", () => {
  it("hashes stably and tells patches apart", () => {
    expect(patchSig(P1)).toBe(patchSig(P1));
    expect(patchSig(P1)).not.toBe(patchSig(P2));
  });

  it("holds while the change is the same and turns to changed after", () => {
    expect(viewedState(WS, "f", P1)).toBe("unviewed");
    markViewed(WS, "f", P1);
    expect(viewedState(WS, "f", P1)).toBe("viewed");
    expect(viewedState(WS, "f", P2)).toBe("changed");
    unmarkViewed(WS, "f");
    expect(viewedState(WS, "f", P1)).toBe("unviewed");
  });

  it("reads back from storage", () => {
    markViewed(WS, "f", P1, 1000);
    resetViewedCache();
    expect(getViewed(WS, "f")?.at).toBe(1000);
    expect(JSON.parse(store.get(VIEWED_KEY)!)[WS].f.sig).toBe(patchSig(P1));
  });

  it("drops marks older than thirty days on the next write", () => {
    markViewed(WS, "old", P1, 0);
    markViewed(WS, "new", P1, VIEWED_TTL_MS + 5);
    expect(getViewed(WS, "old")).toBeUndefined();
    expect(getViewed(WS, "new")).toBeDefined();
  });

  it("checks by the patch hash alone", () => {
    markViewed(WS, "f", P1);
    expect(viewedStateBySig(WS, "f", patchSig(P1))).toBe("viewed");
    expect(viewedStateBySig(WS, "f", patchSig(P2))).toBe("changed");
    expect(viewedStateBySig(WS, "f", undefined)).toBe("changed");
    expect(viewedStateBySig(WS, "g", patchSig(P1))).toBe("unviewed");
  });

  it("tells subscribers", () => {
    let n = 0;
    const off = subscribeViewed(() => n++);
    markViewed(WS, "f", P1);
    unmarkViewed(WS, "f");
    unmarkViewed(WS, "f");
    off();
    expect(n).toBe(2);
  });
});
