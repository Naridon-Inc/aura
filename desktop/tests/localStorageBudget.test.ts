// The origin's localStorage budget has a priority order, and it was inverted.
//
// WebKit gives the app ~5 MB and throws on the write that crosses the line.
// Every writer wrapped `setItem` in a bare try/catch, so crossing it was
// silent — and what got dropped was whichever write happened to be last,
// never whichever write mattered least. Measured on this machine before the
// fix, both webviews were already over the line:
//
//     dev   5,429,466 bytes / 1,093 keys        (quota 5,242,880)
//     prod  5,366,965 bytes /   637 keys
//     biggest single entry: aura.pr.detail.cache.…#31 at 1,617,656 bytes
//     all workspace snapshots together:            50,332 bytes
//
// So a 1.6 MB PR diff that `gh` will re-fetch on demand was squeezing out
// the 2.4 KB record of "you had Claude Code open in marrakesh" — which is
// the switch-worktrees-and-come-back-to-an-empty-pane bug, seen from the
// storage layer.
//
// These are runtime tests, not source scans: the whole point is the
// behaviour under a full origin, and a full origin is easy to simulate.

import { beforeEach, describe, expect, it } from "bun:test";

/** WebKit-shaped localStorage with a hard byte ceiling. Bills key + value,
 *  and throws the same DOMException shape Safari does. */
class QuotaStorage {
  private map = new Map<string, string>();
  constructor(private limitBytes: number) {}

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  used(): number {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
  setItem(k: string, v: string): void {
    const prior = this.map.get(k);
    const after =
      this.used() - (prior === undefined ? 0 : k.length + prior.length) + k.length + v.length;
    if (after > this.limitBytes) {
      const err = new Error("QuotaExceededError") as Error & {
        name: string;
        code: number;
      };
      err.name = "QuotaExceededError";
      err.code = 22;
      throw err;
    }
    this.map.set(k, v);
  }
}

const QUOTA = 200_000;
const store = new QuotaStorage(QUOTA);
(globalThis as { localStorage?: unknown }).localStorage = store;

// Imported after the global is in place — the module reads `localStorage`
// at call time, but keeping the order explicit documents the dependency.
const { setDurable, setCache, pruneOversizedCaches, storageUsage } = await import(
  "../src/lib/localStore"
);

const filler = (n: number) => "x".repeat(n);

/** A workspace snapshot is ~2.4 KB in the wild. */
const SNAPSHOT_KEY = "aura.workspaceSnapshot./Users/me/.aura/worktrees/marrakesh";
const SNAPSHOT_VALUE = filler(2_400);

describe("localStorage budget", () => {
  beforeEach(() => {
    store.clear();
  });

  it("evicts a regenerable cache so the workspace snapshot lands", () => {
    // A day of browsing PRs: the origin fills with caches and nothing else.
    // Written straight to the shim so the setup is the pre-fix world — no
    // per-entry cap, no eviction — and the assertion is about recovery.
    for (let i = 0; i < 4; i++) {
      store.setItem(`aura.pr.detail.cache./repo#${i}`, filler(49_500));
    }
    expect(QUOTA - store.used()).toBeLessThan(SNAPSHOT_VALUE.length);
    // This is the write `saveSnapshot` used to make, and it throws. The old
    // `try {} catch {}` around it is why the pane came back empty.
    expect(() => store.setItem(SNAPSHOT_KEY, SNAPSHOT_VALUE)).toThrow();

    const ok = setDurable(SNAPSHOT_KEY, SNAPSHOT_VALUE);

    expect(ok).toBe(true);
    expect(store.getItem(SNAPSHOT_KEY)).toBe(SNAPSHOT_VALUE);
  });

  it("never sacrifices one durable key to store another", () => {
    const other = "aura.workspaceSnapshot./Users/me/Documents/mono";
    setDurable(other, filler(2_400));
    // One cache holds the slack; durable state fills the rest.
    store.setItem("aura.pr.detail.cache./repo#1", filler(100_000));
    setDurable("aura.openAgents./Users/me/Documents/mono", filler(96_500));
    expect(QUOTA - store.used()).toBeLessThan(SNAPSHOT_VALUE.length);

    expect(setDurable(SNAPSHOT_KEY, SNAPSHOT_VALUE)).toBe(true);
    expect(store.getItem(other)).not.toBeNull();
    expect(store.getItem("aura.openAgents./Users/me/Documents/mono")).not.toBeNull();
    // The cache is the one that paid.
    expect(store.getItem("aura.pr.detail.cache./repo#1")).toBeNull();
  });

  it("refuses a cache entry too large to be worth its own budget", () => {
    // The real offender: one PR detail at 1.6 MB.
    const huge = setCache("aura.pr.detail.cache./repo#31", filler(1_600_000));

    expect(huge).toBe(false);
    expect(store.getItem("aura.pr.detail.cache./repo#31")).toBeNull();
    // …and a normal one still persists.
    expect(setCache("aura.pr.detail.cache./repo#32", filler(20_000))).toBe(true);
  });

  it("drops a stale oversized copy rather than serving it forever", () => {
    store.setItem("aura.pr.detail.cache./repo#31", filler(60_000));
    setCache("aura.pr.detail.cache./repo#31", filler(1_600_000));
    expect(store.getItem("aura.pr.detail.cache./repo#31")).toBeNull();
  });

  it("reclaims pre-existing oversized entries at boot", () => {
    // Installs that predate the cap carry blobs written without one.
    store.setItem("aura.pr.detail.cache./repo#31", filler(150_000));
    store.setItem("aura.workspaceSnapshot./repo", SNAPSHOT_VALUE);

    const freed = pruneOversizedCaches();

    expect(freed).toBeGreaterThan(100_000);
    expect(store.getItem("aura.pr.detail.cache./repo#31")).toBeNull();
    expect(store.getItem("aura.workspaceSnapshot./repo")).toBe(SNAPSHOT_VALUE);
  });

  it("counts a key as regenerable only when it is one", () => {
    store.setItem("aura.pr.detail.cache./repo#1", filler(1_000));
    store.setItem("aura.chat.cache.v1::/repo::ch:general", filler(1_000));
    store.setItem("aura.workspaceSnapshot./repo", filler(1_000));
    store.setItem("aura.openAgents./repo", filler(1_000));
    store.setItem("aura.splitLayout", filler(1_000));

    const { totalBytes, evictableBytes } = storageUsage();

    expect(totalBytes).toBeGreaterThan(evictableBytes);
    // Only the two `.cache.` keys, plus their key lengths.
    expect(evictableBytes).toBeLessThan(2_100);
    expect(evictableBytes).toBeGreaterThan(2_000);
  });
});
