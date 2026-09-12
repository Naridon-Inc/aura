import { describe, expect, test } from "bun:test";

import {
  STALE_AFTER_MS,
  awayLabel,
  isStale,
  lineCount,
  markSeen,
  readSeen,
  seenKey,
  shouldCatchUp,
  trimTrailingBlank,
  type SeenStore,
} from "./catchUp";

/** localStorage, minus the browser. */
function memory(): SeenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

/** A store a private window hands you: every touch throws. */
function refusing(): SeenStore {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
}

const NOW = 1_800_000_000_000;

describe("where the last look is remembered", () => {
  test("one marker per machine and per session", () => {
    // Two boxes can hold sessions of the same name; one marker between them
    // would say "seen" about the one you never opened.
    expect(seenKey("mo@a:/p", "aura-agent-p-1")).not.toBe(
      seenKey("mo@b:/p", "aura-agent-p-1"),
    );
    expect(seenKey("m", "s1")).not.toBe(seenKey("m", "s2"));
    expect(seenKey("m", "s")).toStartWith("aura.place.seen.");
  });

  test("a look is written and read back as the same moment", () => {
    const store = memory();
    expect(readSeen(store, "m", "s")).toBeNull();
    markSeen(store, "m", "s", NOW + 0.7);
    expect(readSeen(store, "m", "s")).toBe(NOW);
  });

  test("a marker that isn't a time reads as never", () => {
    const store = memory();
    store.setItem(seenKey("m", "s"), "yesterday");
    expect(readSeen(store, "m", "s")).toBeNull();
    store.setItem(seenKey("m", "s"), "-5");
    expect(readSeen(store, "m", "s")).toBeNull();
  });

  test("a store that refuses reads as never and swallows the write", () => {
    const store = refusing();
    expect(readSeen(store, "m", "s")).toBeNull();
    expect(() => markSeen(store, "m", "s", NOW)).not.toThrow();
    expect(shouldCatchUp(store, "m", "s", NOW)).toBe(true);
  });
});

describe("when a session is worth catching up on", () => {
  test("never looked means yes", () => {
    expect(isStale(null, NOW)).toBe(true);
  });

  test("just looked means no; long enough away means yes", () => {
    expect(isStale(NOW - 1000, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS + 1, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(true);
    expect(isStale(NOW - 3 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  test("the threshold can be named", () => {
    expect(isStale(NOW - 2000, NOW, 1000)).toBe(true);
    expect(isStale(NOW - 500, NOW, 1000)).toBe(false);
  });

  test("the whole decision reads the store", () => {
    const store = memory();
    expect(shouldCatchUp(store, "m", "s", NOW)).toBe(true);
    markSeen(store, "m", "s", NOW);
    expect(shouldCatchUp(store, "m", "s", NOW + 60_000)).toBe(false);
    expect(shouldCatchUp(store, "m", "s", NOW + STALE_AFTER_MS)).toBe(true);
    // A different session on the same machine is its own question.
    expect(shouldCatchUp(store, "m", "other", NOW + 60_000)).toBe(true);
  });
});

describe("what a capture looks like once trimmed", () => {
  test("the screen of blank lines below the last output goes", () => {
    expect(trimTrailingBlank("a\nb\n\n\n   \n\n")).toBe("a\nb");
  });

  test("blank lines between output stay — they are the program's own", () => {
    expect(trimTrailingBlank("a\n\nb\n")).toBe("a\n\nb");
  });

  test("nothing printed is nothing, not a blank line", () => {
    expect(trimTrailingBlank("")).toBe("");
    expect(trimTrailingBlank("\n\n\n")).toBe("");
    expect(lineCount("")).toBe(0);
  });

  test("the header counts the lines a person will scroll through", () => {
    expect(lineCount("a\nb\nc")).toBe(3);
    expect(lineCount(trimTrailingBlank("a\nb\n\n\n"))).toBe(2);
  });
});

describe("how long you were away, in words", () => {
  test("minutes, then hours, then days", () => {
    expect(awayLabel(NOW - 30_000, NOW)).toBe("away 1m");
    expect(awayLabel(NOW - 35 * 60_000, NOW)).toBe("away 35m");
    expect(awayLabel(NOW - 2 * 3_600_000, NOW)).toBe("away 2h");
    expect(awayLabel(NOW - 47 * 3_600_000, NOW)).toBe("away 47h");
    expect(awayLabel(NOW - 3 * 86_400_000, NOW)).toBe("away 3d");
  });

  test("never looked says so rather than counting from zero", () => {
    expect(awayLabel(null, NOW)).toBe("first look");
  });
});
