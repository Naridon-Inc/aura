// What these pin: the list and the pane read the same key, so a file the pane
// shows as viewed is viewed in the list, and an edit that keeps the line
// counts the same still turns it back to unviewed in both.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { markViewed, resetViewedCache, viewedState } from "./viewedFiles";
import { listedAsViewed, readViewedSigs, sameSigs } from "./viewedSigs";

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
// Same added and removed line counts, different change.
const P1 = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n";
const P2 = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+z\n c\n";

describe("viewed: list and pane agree", () => {
  it("a viewed file is viewed in both, and a changed file goes back to unviewed in both", async () => {
    const disk: Record<string, string> = { f: P1, g: P1 };
    const reads: string[] = [];
    const readPatch = async (_ws: string, p: string) => {
      reads.push(p);
      return disk[p];
    };

    markViewed(WS, "f", disk.f);
    let sigs = await readViewedSigs(WS, ["f", "g"], readPatch);
    expect(viewedState(WS, "f", disk.f)).toBe("viewed");
    expect(listedAsViewed(WS, "f", sigs)).toBe(true);
    // Only the marked file was read.
    expect(reads).toEqual(["f"]);
    expect(listedAsViewed(WS, "g", sigs)).toBe(false);

    disk.f = P2;
    sigs = await readViewedSigs(WS, ["f", "g"], readPatch);
    expect(viewedState(WS, "f", disk.f)).not.toBe("viewed");
    expect(listedAsViewed(WS, "f", sigs)).toBe(false);
  });

  it("a file whose patch can't be read is not viewed", async () => {
    markViewed(WS, "f", P1);
    const sigs = await readViewedSigs(WS, ["f"], async () => {
      throw new Error("gone");
    });
    expect(listedAsViewed(WS, "f", sigs)).toBe(false);
  });

  it("compares hash maps by content", () => {
    expect(sameSigs(new Map([["f", "1"]]), new Map([["f", "1"]]))).toBe(true);
    expect(sameSigs(new Map([["f", "1"]]), new Map([["f", "2"]]))).toBe(false);
    expect(sameSigs(new Map(), new Map([["f", "1"]]))).toBe(false);
  });
});
