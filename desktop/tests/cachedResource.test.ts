// The stale-while-revalidate contract, pinned at the state-transition level.
//
// The hook itself needs a DOM to run, but every rule worth protecting lives in
// the three pure functions it composes — and those are exactly the rules that
// go wrong when a panel hand-rolls its own caching: a failed refresh blanking
// a good answer, or a stale answer being passed off as current.

import { describe, expect, it, beforeEach } from "bun:test";

import {
  seedState,
  loadedState,
  failedState,
  readSharing,
  type ResourceState,
} from "../src/lib/useCachedResource";
import { writeCache, invalidateCache } from "../src/lib/resourceCache";
import { readSrc, stripComments } from "./support/code";

const KEY = "test:cachedResource";

const { sharedRead, freshRead } = readSharing;

/** A read we can hold open, so "still in flight" is a state the test controls
 *  rather than a race it hopes for. */
function deferred<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return { promise, settle, fail };
}

describe("useCachedResource state transitions", () => {
  beforeEach(() => invalidateCache(KEY));

  it("opens empty and loading when nothing has been cached", () => {
    const s = seedState<number[]>(KEY);
    expect(s.data).toBeUndefined();
    expect(s.loading).toBe(true);
    expect(s.staleError).toBeNull();
  });

  it("opens with the cached value and is not loading. There is something real to paint", () => {
    writeCache(KEY, [1, 2, 3]);
    const s = seedState<number[]>(KEY);
    expect(s.data).toEqual([1, 2, 3]);
    expect(s.loading).toBe(false);
  });

  it("does not load at all without a key", () => {
    const s = seedState<number[]>(null);
    expect(s.data).toBeUndefined();
    expect(s.loading).toBe(false);
  });

  it("a successful read becomes the current answer", () => {
    const s = loadedState([4, 5]);
    expect(s.data).toEqual([4, 5]);
    expect(s.loading).toBe(false);
    expect(s.staleError).toBeNull();
  });

  it("a failed refresh keeps what was on screen", () => {
    const prev: ResourceState<number[]> = loadedState([1, 2, 3]);
    const s = failedState(prev, "read failed");
    expect(s.data).toEqual([1, 2, 3]);
  });

  it("a failed refresh never resolves to an empty list", () => {
    const prev: ResourceState<number[]> = loadedState([1, 2, 3]);
    const s = failedState(prev, "read failed");
    // The specific thing this hook exists to prevent: "we couldn't ask"
    // rendering as "there is nothing here".
    expect(s.data).not.toEqual([]);
    expect(s.data?.length).toBe(3);
  });

  it("a failed refresh says the value is not current", () => {
    const s = failedState(loadedState([1]), "boom");
    expect(s.staleError).toBe("boom");
  });

  it("a failed first read leaves nothing to show, and says why", () => {
    const s = failedState(seedState<number[]>(KEY), "boom");
    expect(s.data).toBeUndefined();
    expect(s.loading).toBe(false);
    expect(s.staleError).toBe("boom");
  });

  it("a read that succeeds after a failure clears the stale flag", () => {
    const failed = failedState(loadedState([1]), "boom");
    expect(failed.staleError).not.toBeNull();
    expect(loadedState([2]).staleError).toBeNull();
  });

  it("two panels asking the same question in the same tick share one read", async () => {
    const d = deferred<number[]>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return d.promise;
    };

    const a = sharedRead("dedup:same", load);
    const b = sharedRead("dedup:same", load);
    expect(calls).toBe(1);

    d.settle([7]);
    expect(await a).toEqual([7]);
    expect(await b).toEqual([7]);
  });

  it("panels asking different questions do not share", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const p1 = sharedRead("dedup:a", () => {
      calls += 1;
      return first.promise;
    });
    const p2 = sharedRead("dedup:b", () => {
      calls += 1;
      return second.promise;
    });
    expect(calls).toBe(2);

    first.settle("a");
    second.settle("b");
    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
  });

  it("a shared read is not held onto after it finishes", async () => {
    // Otherwise the first answer for a key would be the only answer that key
    // ever gives — a cache with no expiry pretending to be de-duplication.
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(calls);
    };
    expect(await sharedRead("dedup:cleared", load)).toBe(1);
    expect(await sharedRead("dedup:cleared", load)).toBe(2);
  });

  it("a failed shared read is not held onto either", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve("ok");
    };
    await expect(sharedRead("dedup:failed", load)).rejects.toThrow("boom");
    // A stuck rejected promise would make the key permanently broken.
    expect(await sharedRead("dedup:failed", load)).toBe("ok");
  });

  it("both joiners of a failed read see the failure", async () => {
    const d = deferred<number>();
    const load = () => d.promise;
    const a = sharedRead("dedup:bothfail", load);
    const b = sharedRead("dedup:bothfail", load);
    d.fail(new Error("offline"));
    await expect(a).rejects.toThrow("offline");
    await expect(b).rejects.toThrow("offline");
  });

  it("asking again on purpose does not join the read already running", async () => {
    // The reason `reload` forces: a panel calls it after changing something,
    // and a read that started before the change answers with the old world.
    const stale = deferred<string>();
    const fresh = deferred<string>();
    sharedRead("dedup:reload", () => stale.promise);
    const forced = freshRead("dedup:reload", () => fresh.promise);

    stale.settle("before the change");
    fresh.settle("after the change");
    expect(await forced).toBe("after the change");
  });

  it("a forced read becomes the one later panels join", async () => {
    const stale = deferred<string>();
    const fresh = deferred<string>();
    sharedRead("dedup:takeover", () => stale.promise);
    freshRead("dedup:takeover", () => fresh.promise);

    let extraCalls = 0;
    const joiner = sharedRead("dedup:takeover", () => {
      extraCalls += 1;
      return Promise.resolve("third read");
    });
    expect(extraCalls).toBe(0);

    stale.settle("stale");
    fresh.settle("fresh");
    expect(await joiner).toBe("fresh");
  });

  it("the slower of two reads for a key does not un-register the newer one", async () => {
    // The forced read replaced the shared one in the map. When the shared one
    // finally lands it must not delete the entry that is no longer its own,
    // or a third panel mounting right then starts a redundant read.
    const slow = deferred<string>();
    const fresh = deferred<string>();
    sharedRead("dedup:slowfinish", () => slow.promise);
    const forced = freshRead("dedup:slowfinish", () => fresh.promise);

    slow.settle("slow");
    await Promise.resolve();
    await Promise.resolve();

    let extraCalls = 0;
    const joiner = sharedRead("dedup:slowfinish", () => {
      extraCalls += 1;
      return Promise.resolve("redundant");
    });
    expect(extraCalls).toBe(0);

    fresh.settle("fresh");
    expect(await forced).toBe("fresh");
    expect(await joiner).toBe("fresh");
  });

  it("the hook mounts with a shared read and reloads with a forced one", async () => {
    // The two primitives above are only worth anything if the hook picks the
    // right one for each path, and that choice lives in the hook body — which
    // needs a DOM to run, so it is pinned as text instead. Without this, both
    // paths could quietly call the same primitive and every test above would
    // still pass.
    const flat = stripComments(await readSrc("lib/useCachedResource.ts")).replace(
      /\s+/g,
      " ",
    );
    expect(flat).toContain(
      'mode === "join" ? await sharedRead(mine, loadRef.current) : await freshRead(mine, loadRef.current)',
    );
    expect(flat).toContain('void run("join");');
    expect(flat).toContain('const reload = useCallback(() => run("fresh"), [run]);');
  });

  it("a failure is never left looking like a fresh empty result", () => {
    // Both arms of the same rule: with a previous value, and without one, the
    // state must be distinguishable from a genuine empty answer.
    const genuinelyEmpty = loadedState<number[]>([]);
    expect(genuinelyEmpty.staleError).toBeNull();

    const couldNotAsk = failedState<number[]>(
      { data: [], loading: false, staleError: null },
      "offline",
    );
    expect(couldNotAsk.staleError).toBe("offline");
  });
});
