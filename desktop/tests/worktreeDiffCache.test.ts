// The worktree badges: one round-trip for the whole roster, shared by both
// rosters that draw it.
//
// Two surfaces mount `useWorktreeBadges` — the sidebar roster and the
// Workspaces pane — each on its own 30-second timer, neither aware of the
// other. Each swept the roster one `invoke` per worktree. On a 49-worktree
// checkout that is 98 cross-process hops a cycle; measured on an idle app, 129
// of the 131 `git_diff_stats` calls in a 20-second window were this sweep, a
// quarter of all the IPC in the app, spent on badges for worktrees nobody was
// looking at. On macOS those hops share a queue with terminal keystrokes.
//
// The rules these tests hold:
//
//   One call, however many worktrees, and the second roster inside the window
//   is served from what the first one read.
//
//   A worktree that could not be read is ABSENT, never zeroed. "+0 −0" says the
//   tree is clean, and a failed read is not a clean tree — worktrees are
//   removed under a roster that still holds the old list all the time, so this
//   is the ordinary path, not the exceptional one.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

type Stats = { changed_files: number; added: number; removed: number };

/** Every batch the cache put on the wire, as the list of paths it asked for. */
let batches: string[][] = [];
/** Paths the fake backend reports it could not read. */
let unreadable = new Set<string>();
/** When set, the whole call rejects — the transport itself failing. */
let transportError: string | null = null;
let added = 7;

mock.module("../src/lib/api", () => ({
  api: {
    gitDiffStatsBatch: async (repoRoots: string[]) => {
      batches.push([...repoRoots]);
      if (transportError !== null) throw new Error(transportError);
      return repoRoots.map((repo_root) =>
        unreadable.has(repo_root)
          ? { repo_root, stats: null, error: "no such worktree" }
          : {
              repo_root,
              stats: { changed_files: 1, added, removed: 2 } as Stats,
              error: null,
            },
      );
    },
  },
}));

const { fetchWorktreeDiffs, peekWorktreeDiff, invalidateWorktreeDiffs } =
  await import("../src/lib/worktreeDiffCache");

const realNow = Date.now;

beforeEach(() => {
  batches = [];
  unreadable = new Set();
  transportError = null;
  added = 7;
  invalidateWorktreeDiffs();
});

afterEach(() => {
  Date.now = realNow;
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

const ROSTER = ["/w/a", "/w/b", "/w/c"];

describe("one round-trip for the whole roster", () => {
  it("asks once, not once per worktree", async () => {
    await fetchWorktreeDiffs(ROSTER);
    expect(batches.length).toBe(1);
    expect(batches[0].sort()).toEqual([...ROSTER].sort());
  });

  it("both rosters sweeping at once share a single call", async () => {
    // The sidebar roster and the Workspaces pane mount together.
    await Promise.all([
      fetchWorktreeDiffs(ROSTER),
      fetchWorktreeDiffs(ROSTER),
    ]);
    expect(batches.length).toBe(1);
  });

  it("the second roster inside the window reads no backend at all", async () => {
    await fetchWorktreeDiffs(ROSTER);
    advance(1_000);
    const second = await fetchWorktreeDiffs(ROSTER);
    expect(batches.length).toBe(1);
    expect(Object.keys(second).sort()).toEqual([...ROSTER].sort());
  });

  it("the next cycle is a real read, not the cycle before's numbers", async () => {
    // The freshness window is deliberately under the callers' 30s refresh, so
    // the leading roster always does real work on its own next tick.
    await fetchWorktreeDiffs(ROSTER);
    added = 99;
    advance(30_000);
    const next = await fetchWorktreeDiffs(ROSTER);
    expect(batches.length).toBe(2);
    expect(next["/w/a"].added).toBe(99);
  });

  it("only the worktrees nobody has a fresh answer for go on the wire", async () => {
    await fetchWorktreeDiffs(["/w/a", "/w/b"]);
    batches = [];
    // A roster that has grown by one asks only about the newcomer.
    await fetchWorktreeDiffs(["/w/a", "/w/b", "/w/c"]);
    expect(batches).toEqual([["/w/c"]]);
  });

  it("a duplicated path is asked about once", async () => {
    await fetchWorktreeDiffs(["/w/a", "/w/a", "/w/b"]);
    expect(batches[0].sort()).toEqual(["/w/a", "/w/b"]);
  });
});

describe("a worktree we could not read is not a clean worktree", () => {
  it("an unreadable path is absent, not zeroed", async () => {
    unreadable.add("/w/b");
    const out = await fetchWorktreeDiffs(ROSTER);
    // The whole point: `out["/w/b"]` being `{added:0, removed:0}` would put a
    // confident "nothing changed here" badge on a worktree we know nothing
    // about.
    expect("/w/b" in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(["/w/a", "/w/c"]);
  });

  it("one unreadable worktree does not blank the other rows", async () => {
    unreadable.add("/w/b");
    const out = await fetchWorktreeDiffs(ROSTER);
    expect(out["/w/a"].added).toBe(7);
    expect(out["/w/c"].added).toBe(7);
  });

  it("a failed read is not remembered as an answer", async () => {
    unreadable.add("/w/b");
    await fetchWorktreeDiffs(ROSTER);
    expect(peekWorktreeDiff("/w/b")).toBeUndefined();
    // ...and the next sweep inside the window still asks about it, rather than
    // serving a whole freshness window of no badge off one bad moment.
    batches = [];
    advance(1_000);
    await fetchWorktreeDiffs(ROSTER);
    expect(batches).toEqual([["/w/b"]]);
  });

  it("the transport failing resolves empty rather than rejecting", async () => {
    // A rejection here would propagate into the roster's render path; every
    // row simply has no answer instead.
    transportError = "ipc down";
    const out = await fetchWorktreeDiffs(ROSTER);
    expect(out).toEqual({});
  });

  it("a transport failure is not cached either", async () => {
    transportError = "ipc down";
    await fetchWorktreeDiffs(ROSTER);
    transportError = null;
    batches = [];
    advance(1_000);
    const out = await fetchWorktreeDiffs(ROSTER);
    expect(batches.length).toBe(1);
    expect(Object.keys(out).sort()).toEqual([...ROSTER].sort());
  });
});

describe("what changed under us is not what we last read", () => {
  it("a commit landing throws the numbers away", async () => {
    await fetchWorktreeDiffs(ROSTER);
    added = 42;
    invalidateWorktreeDiffs();
    const out = await fetchWorktreeDiffs(ROSTER);
    expect(batches.length).toBe(2);
    expect(out["/w/a"].added).toBe(42);
  });

  it("a read still in flight when that happens is not written back", async () => {
    // It resolves — somebody is waiting on it — but it describes the world
    // before the commit, so it must not become the cached answer.
    const inFlight = fetchWorktreeDiffs(ROSTER);
    invalidateWorktreeDiffs();
    await inFlight;
    expect(peekWorktreeDiff("/w/a")).toBeUndefined();
  });

  it("subscribes to the app-wide git-changed signal", async () => {
    const src = stripComments(await readSrc("lib/worktreeDiffCache.ts"));
    // Subscribing here rather than in the hook is what stops a surface added
    // later from forgetting to invalidate.
    expect(src).toContain('addEventListener("aura:git-changed"');
  });
});

describe("the roster hook goes through the cache", () => {
  it("useWorktreeBadges no longer calls the backend per worktree", async () => {
    const src = stripComments(await readSrc("lib/useWorktreeBadges.ts"));
    // The regression this guards is the easy one: a later edit reaching for
    // `api.gitDiffStats` again inside the per-worktree map, which looks
    // perfectly reasonable and quietly restores 98 hops a cycle.
    expect(src).not.toContain("api.gitDiffStats");
    expect(src).toContain("fetchWorktreeDiffs(");
  });
});
