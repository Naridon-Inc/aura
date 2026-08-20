// One read of the project's history, shared by every surface that wants it.
//
// Ten surfaces read the same feed and each asks for a different number of rows.
// The backend does the same expensive work whatever the number — it unions the
// log across every branch tip with a `git show` per ref, then pulls teammates'
// intents over the network — and only truncates at the very end. So the rule
// this file protects is: read once at the ceiling, and let each caller slice
// the front off the shared answer.
//
// Getting that wrong is silent. Reading at the caller's limit still returns
// plausible rows to that caller, and hands every later caller a list that is
// too short without anyone noticing.

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

/** Every call the fake backend has been asked to make. */
let asks: (number | undefined)[] = [];
/** Rows the fake backend answers with, newest-first like the real one. */
let answer: { timestamp: number }[] = [];
/** Set to make the next read fail. */
let failWith: string | null = null;
/** Held open when set, so "still in flight" is a state the test controls. */
let hold: { promise: Promise<unknown>; settle: () => void } | null = null;

mock.module("../src/lib/api", () => ({
  api: {
    auraIntentRecent: async (_repoRoot: string, limit?: number) => {
      asks.push(limit);
      if (hold) await hold.promise;
      if (failWith !== null) throw new Error(failWith);
      return answer;
    },
  },
}));

const {
  fetchIntentRows,
  refreshIntentRows,
  peekIntentRows,
  invalidateIntentRows,
} = await import("../src/lib/intentCache");

const REPO = "/tmp/test-repo";

/** `n` rows, newest-first, each identifiable by its timestamp. */
function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ timestamp: n - i }));
}

const realNow = Date.now;

beforeEach(() => {
  asks = [];
  answer = rows(1200);
  failWith = null;
  hold = null;
  invalidateIntentRows(REPO);
});

afterEach(() => {
  Date.now = realNow;
});

/** Move the clock forward without waiting for it. */
function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("one read serves every caller", () => {
  it("asks the backend for the ceiling, not for what the caller wanted", async () => {
    await fetchIntentRows(REPO, 100);
    // 100 is what the caller wants to *see*. Reading 100 would make the cache
    // useless to the next caller, who wants 5000 — and it would look fine.
    expect(asks).toEqual([5000]);
  });

  it("gives a caller exactly the rows a smaller read would have", async () => {
    const got = await fetchIntentRows(REPO, 100);
    expect(got.length).toBe(100);
    // Newest-first, so the front of the list is the newest 100.
    expect(got[0]).toEqual({ timestamp: 1200 });
    expect(got[99]).toEqual({ timestamp: 1101 });
  });

  it("gives a caller that named no limit everything that was read", async () => {
    const got = await fetchIntentRows(REPO);
    expect(got.length).toBe(1200);
  });

  it("does not pad a caller that asked for more than exists", async () => {
    answer = rows(12);
    const got = await fetchIntentRows(REPO, 5000);
    expect(got.length).toBe(12);
  });

  it("serves a wide caller and a narrow one from the same read", async () => {
    const wide = await fetchIntentRows(REPO, 5000);
    const narrow = await fetchIntentRows(REPO, 200);
    expect(asks.length).toBe(1);
    expect(wide.length).toBe(1200);
    expect(narrow.length).toBe(200);
  });

  it("hands out a copy, so one surface's list cannot truncate another's", async () => {
    const mine = await fetchIntentRows(REPO, 50);
    mine.length = 0;
    const yours = await fetchIntentRows(REPO, 50);
    expect(yours.length).toBe(50);
  });

  it("hands out a copy to the caller that named no limit too", async () => {
    // The no-limit path is the tempting one to return as-is — it is the whole
    // cached array. A surface that sorts its own list in place would then be
    // re-ordering what every other surface reads.
    const mine = await fetchIntentRows(REPO);
    mine.length = 0;
    expect(peekIntentRows(REPO)?.length).toBe(1200);
  });
});

describe("concurrent callers share one read", () => {
  it("two panes mounting together cost one backend call", async () => {
    let settle!: () => void;
    hold = {
      promise: new Promise<void>((res) => {
        settle = res;
      }),
      settle: () => settle(),
    };
    const a = fetchIntentRows(REPO, 400);
    const b = fetchIntentRows(REPO, 100);
    hold.settle();
    const [ra, rb] = await Promise.all([a, b]);
    expect(asks.length).toBe(1);
    expect(ra.length).toBe(400);
    expect(rb.length).toBe(100);
  });

  it("a caller that joins an in-flight read still gets its own slice", async () => {
    let settle!: () => void;
    hold = {
      promise: new Promise<void>((res) => {
        settle = res;
      }),
      settle: () => settle(),
    };
    const wide = fetchIntentRows(REPO);
    const narrow = fetchIntentRows(REPO, 3);
    hold.settle();
    expect((await wide).length).toBe(1200);
    // Joining must not mean inheriting the other caller's row count.
    expect((await narrow).length).toBe(3);
  });
});

describe("the freshness window", () => {
  it("serves a second visit without going back to the backend", async () => {
    await fetchIntentRows(REPO, 100);
    advance(3_000);
    await fetchIntentRows(REPO, 100);
    expect(asks.length).toBe(1);
  });

  it("reads again once the window has passed", async () => {
    await fetchIntentRows(REPO, 100);
    advance(11_000);
    await fetchIntentRows(REPO, 100);
    expect(asks.length).toBe(2);
  });

  it("refresh reads even inside the window", async () => {
    await fetchIntentRows(REPO, 100);
    advance(1_000);
    await refreshIntentRows(REPO, 100);
    // A surface that just logged an intent has to see it; a read that started
    // before the change would answer with the old world.
    expect(asks.length).toBe(2);
  });

  it("a refresh restarts the window for everyone else", async () => {
    await fetchIntentRows(REPO, 100);
    advance(9_000);
    await refreshIntentRows(REPO, 100);
    await fetchIntentRows(REPO, 100);
    expect(asks.length).toBe(2);
  });
});

describe("peeking and invalidating", () => {
  it("peeks nothing before any read has landed", () => {
    expect(peekIntentRows(REPO)).toBeUndefined();
  });

  it("peeks the cached rows, sliced, after a read", async () => {
    await fetchIntentRows(REPO);
    expect(peekIntentRows(REPO, 5)?.length).toBe(5);
  });

  it("peeks a stale read rather than nothing", async () => {
    await fetchIntentRows(REPO);
    advance(60_000);
    // Something true a minute ago beats a spinner.
    expect(peekIntentRows(REPO)?.length).toBe(1200);
  });

  it("goes cold after invalidation", async () => {
    await fetchIntentRows(REPO);
    invalidateIntentRows(REPO);
    expect(peekIntentRows(REPO)).toBeUndefined();
    await fetchIntentRows(REPO);
    expect(asks.length).toBe(2);
  });

  it("keeps repos apart", async () => {
    await fetchIntentRows(REPO);
    await fetchIntentRows("/tmp/other-repo");
    expect(asks.length).toBe(2);
    invalidateIntentRows("/tmp/other-repo");
  });
});

describe("a failed read", () => {
  it("rejects rather than answering with an empty history", async () => {
    failWith = "git exploded";
    await expect(fetchIntentRows(REPO, 10)).rejects.toThrow("git exploded");
  });

  it("does not cache the failure", async () => {
    failWith = "git exploded";
    await fetchIntentRows(REPO, 10).catch(() => {});
    failWith = null;
    const got = await fetchIntentRows(REPO, 10);
    expect(got.length).toBe(10);
    expect(asks.length).toBe(2);
  });

  it("leaves the last good answer peekable", async () => {
    await fetchIntentRows(REPO);
    advance(11_000);
    failWith = "git exploded";
    await fetchIntentRows(REPO).catch(() => {});
    // A refresh that fails must not blank a surface that was already painted.
    expect(peekIntentRows(REPO)?.length).toBe(1200);
  });
});

describe("every surface reads through the cache", () => {
  it("nothing but the cache calls auraIntentRecent", async () => {
    // The whole saving is that there is one read. A single component going
    // straight to `api` re-introduces the serial branch walk and the network
    // pull for itself, and nothing about the app looks wrong when it does.
    const callers: string[] = [];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    // `import.meta.dir`, not a URL pathname — this repo lives under a path
    // with a space in it, and a URL would percent-encode it into nothing.
    const root = `${import.meta.dir}/../src/`;
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/intentCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("auraIntentRecent")) callers.push(rel);
    }
    expect(callers).toEqual([]);
  });

  it("the cache reads at the ceiling the backend allows", async () => {
    const ts = stripComments(await readSrc("lib/intentCache.ts"));
    expect(ts).toContain("const INTENT_READ_LIMIT = 5000;");
    expect(ts).toContain("api\n    .auraIntentRecent(repoRoot, INTENT_READ_LIMIT)");
  });
});
