// "Where does this branch stand?" asked once, not four times.
//
// Four components poll git state on the same 6-second cadence and none of them
// unmounts when you switch rail tabs. Each `gitAheadBehind` is two git process
// spawns, each `gitDiffStats` two more. The rule here is that overlapping asks
// collapse into one read — and, just as important, that a failed read stays
// failed. Every caller has a hand-written catch whose whole job is to stop a
// git failure being rendered as "this branch is published nowhere"; a cache
// that answered with a zeroed struct, or with stale numbers stamped as current,
// would defeat all of them at once from a single place.

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

let abCalls = 0;
let dsCalls = 0;
let abFail: string | null = null;
let hold: { promise: Promise<void>; settle: () => void } | null = null;

function gate() {
  let settle!: () => void;
  const promise = new Promise<void>((res) => {
    settle = res;
  });
  return { promise, settle: () => settle() };
}

mock.module("../src/lib/api", () => ({
  api: {
    gitAheadBehind: async (_repoRoot: string) => {
      abCalls += 1;
      if (hold) await hold.promise;
      if (abFail !== null) throw new Error(abFail);
      return { ahead: 2, behind: 0, upstream: "origin/main" };
    },
    gitDiffStats: async (_repoRoot: string) => {
      dsCalls += 1;
      if (hold) await hold.promise;
      return { changed_files: 7, insertions: 1, deletions: 1 };
    },
  },
}));

const { fetchAheadBehind, fetchDiffStats, invalidateGitState } = await import(
  "../src/lib/gitStateCache"
);

const REPO = "/tmp/test-repo";
const realNow = Date.now;

beforeEach(() => {
  abCalls = 0;
  dsCalls = 0;
  abFail = null;
  hold = null;
  invalidateGitState();
});

afterEach(() => {
  Date.now = realNow;
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("overlapping pollers collapse to one read", () => {
  it("three surfaces asking inside one window cost one git read", async () => {
    await fetchAheadBehind(REPO);
    advance(1_000);
    await fetchAheadBehind(REPO);
    advance(1_000);
    await fetchAheadBehind(REPO);
    // Three components, one 6s cycle, one read — instead of three reads and
    // six git process spawns.
    expect(abCalls).toBe(1);
  });

  it("the next poll cycle is a real read", async () => {
    await fetchAheadBehind(REPO);
    advance(6_000);
    await fetchAheadBehind(REPO);
    expect(abCalls).toBe(2);
  });

  it("concurrent callers join one in-flight read", async () => {
    hold = gate();
    const a = fetchAheadBehind(REPO);
    const b = fetchAheadBehind(REPO);
    hold.settle();
    await Promise.all([a, b]);
    expect(abCalls).toBe(1);
  });

  it("keeps the two commands apart", async () => {
    await fetchAheadBehind(REPO);
    // A surface that only wants ahead/behind must not be billed for the diff
    // stats as well.
    expect(dsCalls).toBe(0);
    await fetchDiffStats(REPO);
    expect(dsCalls).toBe(1);
    expect(abCalls).toBe(1);
  });

  it("keeps repos apart", async () => {
    await fetchAheadBehind(REPO);
    await fetchAheadBehind("/tmp/other");
    expect(abCalls).toBe(2);
  });
});

describe("a failed read is not an answer", () => {
  it("rejects instead of resolving to a zeroed struct", async () => {
    abFail = "not a git repository";
    // A zeroed AheadBehind renders as an unpublished branch. That is the exact
    // confident lie every caller's catch exists to prevent.
    await expect(fetchAheadBehind(REPO)).rejects.toThrow("not a git repository");
  });

  it("caches nothing, so the next read is real", async () => {
    abFail = "not a git repository";
    await fetchAheadBehind(REPO).catch(() => {});
    abFail = null;
    const ab = await fetchAheadBehind(REPO);
    expect(ab.ahead).toBe(2);
    expect(abCalls).toBe(2);
  });

  it("does not leave the failed read in flight for the next caller to join", async () => {
    abFail = "not a git repository";
    await fetchAheadBehind(REPO).catch(() => {});
    abFail = null;
    await fetchAheadBehind(REPO);
    // If the rejected promise stayed in `inflight`, this second call would have
    // joined it and rejected too.
    expect(abCalls).toBe(2);
  });
});

describe("the working tree changing underneath", () => {
  it("throws away what was known", async () => {
    await fetchAheadBehind(REPO);
    invalidateGitState();
    await fetchAheadBehind(REPO);
    expect(abCalls).toBe(2);
  });

  it("does not cache a read that was already running when it changed", async () => {
    hold = gate();
    const inflight = fetchAheadBehind(REPO);
    // The commit lands while the read is still out. What comes back describes
    // the world before it.
    invalidateGitState();
    hold.settle();
    await inflight;
    hold = null;
    await fetchAheadBehind(REPO);
    // Two reads: the stale one was allowed to resolve for the caller waiting on
    // it, but was never written to the cache. Without the epoch guard it would
    // have been stored with a fresh timestamp and served to the next surface as
    // current.
    expect(abCalls).toBe(2);
  });

  it("clears both commands, not just the one that was asked for", async () => {
    await fetchAheadBehind(REPO);
    await fetchDiffStats(REPO);
    invalidateGitState();
    await fetchAheadBehind(REPO);
    await fetchDiffStats(REPO);
    expect(abCalls).toBe(2);
    expect(dsCalls).toBe(2);
  });
});

describe("wiring", () => {
  it("invalidates on the app's git-changed signal", async () => {
    // The listener needs a DOM, so the rule is tested above on the function it
    // calls and the subscription itself is pinned here. Subscribing inside the
    // cache — not in each caller — is what stops a surface added later from
    // reading through it and forgetting to invalidate.
    const ts = stripComments(await readSrc("lib/gitStateCache.ts"));
    expect(ts).toContain(
      'window.addEventListener("aura:git-changed", invalidateGitState)',
    );
  });

  it("stays under the callers' own poll cadence", async () => {
    const ts = stripComments(await readSrc("lib/gitStateCache.ts"));
    // A window at or above the 6000ms poll interval would start handing
    // surfaces answers older than they believe they are showing.
    const m = ts.match(/const FRESH_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThan(6000);
  });

  it("no rail surface still polls git state straight at the api", async () => {
    const glob = new Bun.Glob("components/rightrail/**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.gitAheadBehind") || body.includes("api.gitDiffStats")) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
