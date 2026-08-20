// "Is anything reaching my work?" asked once, not six times.
//
// Impacts and conflicts drive ambient chrome, so everything that shows them
// polls: App.tsx every 4s, useLiveSync every 4s, the banner every 30s, plus
// three panes that read on mount. Each read opens a `.aura/*.jsonl` — 796 KB
// of conflicts in this repo — and parses it line by line. Two four-second
// timers asking the same question a fraction of a second apart is the shape
// this file exists to collapse.
//
// The other half is subtler and is where a cache normally introduces a bug:
// acknowledging an impact and then refreshing inside the freshness window must
// not put the row back. A button that worked perfectly would look broken.

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

let impactCalls = 0;
let conflictCalls = 0;
let astCalls = 0;
let resolvedImpacts: string[] = [];
let impactFail: string | null = null;
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
    auraReadImpacts: async (_repoRoot: string) => {
      impactCalls += 1;
      if (hold) await hold.promise;
      if (impactFail !== null) throw new Error(impactFail);
      return [{ id: "a1", resolved: false }];
    },
    auraListConflicts: async (_repoRoot: string) => {
      conflictCalls += 1;
      return [{ kind: "git" }];
    },
    auraConflictsList: async (_repoRoot: string) => {
      astCalls += 1;
      return [{ id: "c1", resolved_at: null }];
    },
    auraResolveImpact: async (_repoRoot: string, alertId: string) => {
      resolvedImpacts.push(alertId);
    },
    auraConflictsResolve: async (_repoRoot: string, args: unknown) => args,
  },
}));

const {
  fetchImpacts,
  fetchConflicts,
  fetchAstConflicts,
  resolveImpact,
  resolveAstConflict,
  invalidateAmbient,
} = await import("../src/lib/ambientCache");

const REPO = "/tmp/test-repo";
const OTHER = "/tmp/other-repo";
const realNow = Date.now;

beforeEach(() => {
  impactCalls = 0;
  conflictCalls = 0;
  astCalls = 0;
  resolvedImpacts = [];
  impactFail = null;
  hold = null;
  invalidateAmbient(REPO);
  invalidateAmbient(OTHER);
});

afterEach(() => {
  Date.now = realNow;
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("the two four-second timers collapse into one read", () => {
  it("App.tsx and useLiveSync ticking together cost one read each", async () => {
    // App.tsx's tick.
    await Promise.all([
      fetchImpacts(REPO),
      fetchConflicts(REPO),
      fetchAstConflicts(REPO),
    ]);
    advance(300); // useLiveSync's timer, a fraction of a second later.
    await Promise.all([fetchImpacts(REPO), fetchAstConflicts(REPO)]);
    expect(impactCalls).toBe(1);
    expect(astCalls).toBe(1);
  });

  it("the banner's 30s tick rides whatever the fast pollers already read", async () => {
    await fetchImpacts(REPO);
    advance(2_000);
    await fetchImpacts(REPO);
    expect(impactCalls).toBe(1);
  });

  it("the next poll cycle is a real read", async () => {
    await fetchImpacts(REPO);
    advance(4_000);
    await fetchImpacts(REPO);
    expect(impactCalls).toBe(2);
  });

  it("concurrent callers join the read already running", async () => {
    hold = gate();
    const a = fetchImpacts(REPO);
    const b = fetchImpacts(REPO);
    hold.settle();
    await Promise.all([a, b]);
    expect(impactCalls).toBe(1);
  });

  it("keeps the three reads apart", async () => {
    await fetchImpacts(REPO);
    // The conflict list and the AST conflict list are different commands over
    // different files; one is not a substitute for the other.
    expect(conflictCalls).toBe(0);
    expect(astCalls).toBe(0);
  });

  it("keeps repos apart", async () => {
    await fetchImpacts(REPO);
    await fetchImpacts(OTHER);
    expect(impactCalls).toBe(2);
  });
});

describe("acknowledging something makes the cache forget it", () => {
  it("a refresh right after Acknowledge does not put the row back", async () => {
    await fetchImpacts(REPO);
    await resolveImpact(REPO, "a1");
    // ImpactsPane refreshes immediately, well inside the freshness window. If
    // the pre-resolve list were still cached the acknowledged row would
    // reappear and the button would look broken.
    await fetchImpacts(REPO);
    expect(resolvedImpacts).toEqual(["a1"]);
    expect(impactCalls).toBe(2);
  });

  it("does not throw away the other repo's impacts", async () => {
    await fetchImpacts(REPO);
    await fetchImpacts(OTHER);
    await resolveImpact(REPO, "a1");
    await fetchImpacts(OTHER);
    expect(impactCalls).toBe(2);
  });

  it("does not throw away the conflict lists, which it did not change", async () => {
    await fetchConflicts(REPO);
    await fetchAstConflicts(REPO);
    await resolveImpact(REPO, "a1");
    await fetchConflicts(REPO);
    await fetchAstConflicts(REPO);
    expect(conflictCalls).toBe(1);
    expect(astCalls).toBe(1);
  });

  it("resolving an AST conflict forgets the AST conflict list", async () => {
    await fetchAstConflicts(REPO);
    await resolveAstConflict(REPO, {
      id: "c1",
      strategy: "ours",
      resolved_in_commit: null,
    } as never);
    await fetchAstConflicts(REPO);
    expect(astCalls).toBe(2);
  });

  it("resolving an AST conflict leaves impacts alone", async () => {
    await fetchImpacts(REPO);
    await resolveAstConflict(REPO, { id: "c1" } as never);
    await fetchImpacts(REPO);
    expect(impactCalls).toBe(1);
  });

  it("returns the resolved row to the caller", async () => {
    const row = await resolveAstConflict(REPO, { id: "c1" } as never);
    expect(row).toEqual({ id: "c1" } as never);
  });
});

describe("a failed read is not an empty list", () => {
  it("rejects rather than answering 'nothing is reaching your work'", async () => {
    impactFail = "impacts file is unreadable";
    // Every caller catches this itself and keeps its last known list. An empty
    // array here would be published as reassurance.
    await expect(fetchImpacts(REPO)).rejects.toThrow("impacts file is unreadable");
  });

  it("caches nothing, so the next read is real", async () => {
    impactFail = "impacts file is unreadable";
    await fetchImpacts(REPO).catch(() => {});
    impactFail = null;
    const got = await fetchImpacts(REPO);
    expect(got.length).toBe(1);
    expect(impactCalls).toBe(2);
  });

  it("leaves no rejected promise for the next caller to join", async () => {
    impactFail = "impacts file is unreadable";
    await fetchImpacts(REPO).catch(() => {});
    impactFail = null;
    await fetchImpacts(REPO);
    expect(impactCalls).toBe(2);
  });
});

describe("the world changing while a read is out", () => {
  it("does not cache a read that started before the resolve landed", async () => {
    hold = gate();
    const inflight = fetchImpacts(REPO);
    // The acknowledge lands while the read is still out; what comes back
    // describes the world before it.
    await resolveImpact(REPO, "a1");
    hold.settle();
    await inflight;
    hold = null;
    await fetchImpacts(REPO);
    // Two reads: the stale one resolved for the caller waiting on it but was
    // never stored. Without the epoch guard it would have been written with a
    // fresh timestamp and served to the next surface as current.
    expect(impactCalls).toBe(2);
  });

  it("invalidateAmbient clears all three, not just the one asked for", async () => {
    await fetchImpacts(REPO);
    await fetchConflicts(REPO);
    await fetchAstConflicts(REPO);
    invalidateAmbient(REPO);
    await fetchImpacts(REPO);
    await fetchConflicts(REPO);
    await fetchAstConflicts(REPO);
    expect([impactCalls, conflictCalls, astCalls]).toEqual([2, 2, 2]);
  });
});

describe("wiring", () => {
  it("stays under the pollers' own cadence", async () => {
    const ts = stripComments(await readSrc("lib/ambientCache.ts"));
    const m = ts.match(/const FRESH_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    // At or above the 4000ms poll and a surface starts showing answers older
    // than it believes it is showing.
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThan(4000);
  });

  it("nothing outside the cache reads or resolves these directly", async () => {
    // One component going straight to `api` re-introduces the whole-file read
    // for itself — and a resolve that skips the wrapper leaves the cache
    // holding the row it just cleared.
    const names = [
      "api.auraReadImpacts",
      "api.auraListConflicts",
      "api.auraConflictsList",
      "api.auraResolveImpact",
      "api.auraConflictsResolve",
    ];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    // `import.meta.dir`, not a URL pathname — this repo lives under a path
    // with a space in it, which a URL would percent-encode into nothing.
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/ambientCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      for (const n of names) if (body.includes(n)) offenders.push(`${rel} → ${n}`);
    }
    expect(offenders).toEqual([]);
  });
});
