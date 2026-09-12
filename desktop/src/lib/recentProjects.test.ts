import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  RECENTS_KEY,
  RECENTS_MAX,
  forgetRecent,
  lastRecent,
  readRecents,
  rememberRecent,
} from "./recentProjects";

// Nothing here is kept unless a test says so — the customisation store is
// injected, so these run without standing it up.
const keepNothing = () => false;
const keep = (...roots: string[]) => (r: string) => roots.includes(r);

// bun's runner has no DOM, and this module reads storage through try/catch —
// so without a real store every read would return [] and the tests below would
// pass while proving nothing.
function installStore() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

function seed(list: unknown) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
}

beforeEach(() => {
  installStore();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("remembering a project", () => {
  it("appends on first sight and leaves the order alone on re-open", () => {
    const a = rememberRecent([], "/a", { isKept: keepNothing });
    const b = rememberRecent(a, "/b", { isKept: keepNothing });
    expect(b).toEqual(["/a", "/b"]);
    // Re-opening one you already have must not shuffle the rail — tiles that
    // move while you are reaching for one are worse than an imperfect order.
    expect(rememberRecent(b, "/a", { isKept: keepNothing })).toBe(b);
  });

  it("puts the sample at the front when asked", () => {
    const list = rememberRecent(["/a", "/b"], "/sample", {
      front: true,
      isKept: keepNothing,
    });
    expect(list).toEqual(["/sample", "/a", "/b"]);
  });

  it("refuses managed agent worktrees", () => {
    const prev = ["/repo"];
    expect(
      rememberRecent(prev, "/repo/.claude/worktrees/agent-a40050d3", {
        isKept: keepNothing,
      }),
    ).toBe(prev);
  });
});

describe("the cap", () => {
  const full = () =>
    Array.from({ length: RECENTS_MAX }, (_, i) => `/p${i}`);

  it("is high enough that eight projects are nowhere near it", () => {
    // The bug this file exists for: a list of eight was already at the cap, so
    // opening a ninth project silently forgot the first.
    let list: string[] = [];
    for (let i = 0; i < 9; i++) {
      list = rememberRecent(list, `/p${i}`, { isKept: keepNothing });
    }
    expect(list).toHaveLength(9);
    expect(list[0]).toBe("/p0");
  });

  it("evicts the oldest unkept project once genuinely full", () => {
    const list = rememberRecent(full(), "/new", { isKept: keepNothing });
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list).not.toContain("/p0");
    expect(list.at(-1)).toBe("/new");
  });

  it("never evicts a pinned or archived project", () => {
    // /p0 is the oldest and would have been the victim. The user asked to keep
    // it, so the next one down goes instead.
    const list = rememberRecent(full(), "/new", { isKept: keep("/p0") });
    expect(list).toContain("/p0");
    expect(list).not.toContain("/p1");
    expect(list).toContain("/new");
  });

  it("runs over the cap rather than forget something you kept", () => {
    const everything = full();
    const list = rememberRecent(everything, "/new", {
      isKept: keep(...everything),
    });
    expect(list).toHaveLength(RECENTS_MAX + 1);
    expect(list).toEqual([...everything, "/new"]);
  });

  it("never drops the project that was just opened", () => {
    const list = rememberRecent(full(), "/new", { isKept: keepNothing });
    expect(list).toContain("/new");
  });
});

describe("reading what was stored", () => {
  it("drops managed worktrees and writes the repair back", () => {
    seed(["/a", "/a/.aura/worktrees/x", "/b"]);
    expect(readRecents(keepNothing)).toEqual(["/a", "/b"]);
    expect(JSON.parse(localStorage.getItem(RECENTS_KEY)!)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("keeps a list longer than the old eight instead of trimming it", () => {
    const stored = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    seed(stored);
    expect(readRecents(keepNothing)).toEqual(stored);
  });

  it("survives junk without throwing", () => {
    localStorage.setItem(RECENTS_KEY, "not json");
    expect(readRecents(keepNothing)).toEqual([]);
    seed({ not: "an array" });
    expect(readRecents(keepNothing)).toEqual([]);
    seed(["/a", 7, null, "", "/b"]);
    expect(readRecents(keepNothing)).toEqual(["/a", "/b"]);
  });

  it("reports the newest as the last known root", () => {
    seed(["/a", "/b", "/c"]);
    expect(lastRecent()).toBe("/c");
    localStorage.clear();
    expect(lastRecent()).toBeNull();
  });
});

describe("forgetting", () => {
  it("removes the closed project and leaves the rest", () => {
    expect(forgetRecent(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });

  it("is a no-op for a project that isn't there", () => {
    const prev = ["/a"];
    expect(forgetRecent(prev, "/b")).toBe(prev);
  });
});
