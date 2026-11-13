// The shared cache's rules beyond the state transitions: one read for many
// askers, a freshness window that really skips the read, answers kept across
// restarts for the keys that ask for it, and account-scoped keys that never
// outlive the account they were read as.
//
// These are the properties that make it safe to put a slow read (every agent
// CLI's version, every MCP server's tool list, an org's member list) behind
// the cache instead of re-asking on every open, so each one is pinned here.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

/** bun has no localStorage; a Map is the whole of the API the cache uses. */
const disk = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => disk.get(k) ?? null,
  setItem: (k: string, v: string) => void disk.set(k, v),
  removeItem: (k: string) => void disk.delete(k),
  clear: () => disk.clear(),
  get length() {
    return disk.size;
  },
  key: (i: number) => [...disk.keys()][i] ?? null,
};

import {
  accountEpoch,
  forgetAccountScoped,
  hasCache,
  invalidateCache,
  invalidateCachePrefix,
  onAccountScopeChanged,
  peekCache,
  watchCache,
  writeCache,
} from "../src/lib/resourceCache";
import { isFresh, readCached } from "../src/lib/useCachedResource";

const PREFIX = "aura.cache.v1:";

function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  return { promise, settle };
}

/** A load that counts its calls and answers when told. */
function heldLoad<T>() {
  const pending: Array<ReturnType<typeof deferred<T>>> = [];
  const load = () => {
    const d = deferred<T>();
    pending.push(d);
    return d.promise;
  };
  return { load, pending, calls: () => pending.length };
}

const realNow = Date.now;
function advance(ms: number) {
  const base = Date.now();
  Date.now = () => base + ms;
}

beforeEach(() => {
  disk.clear();
  invalidateCachePrefix("t:");
  invalidateCachePrefix("cloud:t");
});
afterEach(() => {
  Date.now = realNow;
});

describe("readCached shares one read", () => {
  it("concurrent askers get one load and one answer", async () => {
    const h = heldLoad<string[]>();
    const a = readCached("t:agents", h.load);
    const b = readCached("t:agents", h.load);
    const c = readCached("t:agents", h.load);
    expect(h.calls()).toBe(1);
    h.pending[0]!.settle(["claude", "codex"]);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toEqual(["claude", "codex"]);
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
    expect(peekCache<string[]>("t:agents")).toBe(ra);
  });

  it("force starts its own read instead of joining an older one", async () => {
    const h = heldLoad<number>();
    const old = readCached("t:n", h.load);
    const forced = readCached("t:n", h.load, { force: true });
    expect(h.calls()).toBe(2);
    h.pending[1]!.settle(2);
    h.pending[0]!.settle(1);
    expect(await forced).toBe(2);
    await old;
  });
});

describe("freshness window", () => {
  it("an answer younger than freshMs is served without reading", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await readCached("t:fresh", load, { freshMs: 60_000 });
    expect(await readCached("t:fresh", load, { freshMs: 60_000 })).toBe(1);
    expect(calls).toBe(1);
    expect(isFresh("t:fresh", 60_000)).toBe(true);
  });

  it("an older answer is read again", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await readCached("t:stale", load, { freshMs: 60_000 });
    advance(61_000);
    expect(isFresh("t:stale", 60_000)).toBe(false);
    expect(await readCached("t:stale", load, { freshMs: 60_000 })).toBe(2);
  });

  it("force reads inside the window", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await readCached("t:force", load, { freshMs: 60_000 });
    expect(await readCached("t:force", load, { freshMs: 60_000, force: true })).toBe(2);
  });

  it("no freshMs means always revalidate", () => {
    writeCache("t:none", 1);
    expect(isFresh("t:none", undefined)).toBe(false);
  });
});

describe("persisted answers", () => {
  it("a persisted write survives a memory miss, as on the next start", async () => {
    await readCached("t:machine", async () => ["claude"], { persist: true });
    expect(JSON.parse(disk.get(PREFIX + "t:machine")!).data).toEqual(["claude"]);

    // What an earlier run left behind, and nothing in memory yet.
    disk.set(PREFIX + "t:earlier", JSON.stringify({ data: ["codex"], ts: Date.now() }));
    expect(hasCache("t:earlier")).toBe(true);
    expect(peekCache<string[]>("t:earlier")).toEqual(["codex"]);
  });

  it("an entry from an older shape version is ignored", () => {
    disk.set("aura.cache.v0:t:old", JSON.stringify({ data: 1, ts: Date.now() }));
    expect(peekCache("t:old")).toBeUndefined();
  });

  it("a corrupt entry reads as a miss, not a throw", () => {
    disk.set(PREFIX + "t:junk", "{not json");
    expect(peekCache("t:junk")).toBeUndefined();
  });

  it("without persist nothing reaches storage", async () => {
    await readCached("t:session", async () => 1);
    expect(disk.has(PREFIX + "t:session")).toBe(false);
  });

  it("invalidation drops the persisted copy too", async () => {
    writeCache("t:a", 1, { persist: true });
    writeCache("t:b", 2, { persist: true });
    writeCache("t:c", 3, { persist: true });
    invalidateCache("t:a");
    expect(disk.has(PREFIX + "t:a")).toBe(false);
    expect(peekCache("t:a")).toBeUndefined();
    invalidateCachePrefix("t:");
    expect([...disk.keys()].filter((k) => k.startsWith(PREFIX + "t:"))).toEqual([]);
    expect(peekCache("t:b")).toBeUndefined();
  });
});

describe("watchers", () => {
  it("every surface showing a key hears a write from anywhere", async () => {
    const seen: number[] = [];
    const stop = watchCache<number>("t:watched", (v) => seen.push(v));
    writeCache("t:watched", 1);
    await readCached("t:watched", async () => 2, { force: true });
    stop();
    writeCache("t:watched", 3);
    expect(seen).toEqual([1, 2]);
  });
});

describe("account-scoped keys", () => {
  it("are never persisted, even when asked to be", async () => {
    await readCached("cloud:t-members", async () => ["ana"], { persist: true });
    expect([...disk.keys()].some((k) => k.includes("cloud:"))).toBe(false);
    expect(peekCache("cloud:t-members")).toEqual(["ana"]);
  });

  it("an org or sign-in change drops only cloud keys, then tells listeners", () => {
    writeCache("cloud:t-org-a", ["ana"]);
    writeCache("t:local", "kept", { persist: true });
    const before = accountEpoch();
    const heard: Array<unknown> = [];
    const stop = onAccountScopeChanged(() => heard.push(peekCache("cloud:t-org-a")));
    forgetAccountScoped();
    stop();
    expect(accountEpoch()).toBe(before + 1);
    // Listeners re-read straight away, so they must find the old org gone.
    expect(heard).toEqual([undefined]);
    expect(peekCache("t:local")).toBe("kept");
  });

  it("a read started as the previous account is neither stored nor joined", async () => {
    const h = heldLoad<string[]>();
    const old = readCached("cloud:t-roster", h.load);
    forgetAccountScoped();
    const fresh = readCached("cloud:t-roster", h.load);
    // The new account's caller did not join the old account's read.
    expect(h.calls()).toBe(2);
    h.pending[0]!.settle(["org-a person"]);
    await old;
    expect(peekCache("cloud:t-roster")).toBeUndefined();
    h.pending[1]!.settle(["org-b person"]);
    expect(await fresh).toEqual(["org-b person"]);
    expect(peekCache<string[]>("cloud:t-roster")).toEqual(["org-b person"]);
  });

  it("a local key's read is unaffected by an account change", async () => {
    const h = heldLoad<number>();
    const p = readCached("t:machine-only", h.load);
    forgetAccountScoped();
    h.pending[0]!.settle(7);
    expect(await p).toBe(7);
    expect(peekCache("t:machine-only")).toBe(7);
  });
});

describe("reopen cost", () => {
  // A reopen of a pane under the cache is a memory read. The load below
  // stands in for the backend read it skips; its length is what the read
  // measured on this machine (agents_list before the backend cache: ~4 s
  // warm, so 40 ms here is a generous floor, not the real cost).
  it("a reopen inside the window returns without waiting for the load", async () => {
    const slow = () => new Promise<number[]>((r) => setTimeout(() => r([1, 2, 3]), 40));
    const t0 = performance.now();
    await readCached("t:reopen", slow, { freshMs: 60_000, persist: true });
    const first = performance.now() - t0;
    const t1 = performance.now();
    await readCached("t:reopen", slow, { freshMs: 60_000, persist: true });
    const reopen = performance.now() - t1;
    expect(first).toBeGreaterThanOrEqual(35);
    expect(reopen).toBeLessThan(5);
  });
});
