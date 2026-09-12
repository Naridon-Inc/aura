import { describe, expect, test } from "bun:test";

import { createLatestOnly } from "../src/lib/latestOnly";

/** A promise with its settle handles held outside it, so a test can decide
 *  the order two runs come back in. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NEVER = () => new Promise<never>(() => {});

describe("answering only if you are still the question", () => {
  test("one run on its own answers with its value", async () => {
    const latest = createLatestOnly();
    const got = await latest.run(async () => 41 + 1, 1000, "too slow");
    expect(got).toEqual({ kind: "ok", value: 42 });
  });

  test("the slower of two runs cannot paint over the newer one", async () => {
    const latest = createLatestOnly();
    const first = deferred<string>();
    const second = deferred<string>();

    const a = latest.run(() => first.promise, 1000, "too slow");
    const b = latest.run(() => second.promise, 1000, "too slow");

    // The newer question answers first, then the older one straggles in.
    second.resolve("the project you are looking at");
    first.resolve("the project you left");

    expect(await b).toEqual({ kind: "ok", value: "the project you are looking at" });
    expect(await a).toEqual({ kind: "stale" });
  });

  test("a retired run has nothing to say, even when it succeeds", async () => {
    const latest = createLatestOnly();
    const only = deferred<number>();
    const run = latest.run(() => only.promise, 1000, "too slow");
    latest.retire();
    only.resolve(7);
    expect(await run).toEqual({ kind: "stale" });
  });

  test("a retired run's failure is not shown either", async () => {
    // Otherwise closing a surface replaces the next thing you open with the
    // error from the thing you closed.
    const latest = createLatestOnly();
    const only = deferred<number>();
    const run = latest.run(() => only.promise, 1000, "too slow");
    latest.retire();
    only.reject(new Error("the backend gave up"));
    expect(await run).toEqual({ kind: "stale" });
  });
});

describe("waiting for a bounded time, then saying so", () => {
  test("work that never answers still settles, with the sentence given", async () => {
    const latest = createLatestOnly();
    const got = await latest.run(NEVER, 5, "The check is taking longer than it should.");
    expect(got).toEqual({
      kind: "failed",
      message: "The check is taking longer than it should.",
    });
  });

  test("a failure keeps its own words rather than the timeout's", async () => {
    const latest = createLatestOnly();
    const got = await latest.run(
      async () => {
        throw new Error("aura doctor was killed before it could answer");
      },
      1000,
      "too slow",
    );
    expect(got).toEqual({
      kind: "failed",
      message: "aura doctor was killed before it could answer",
    });
  });

  test("a thrown non-error is still readable", async () => {
    const latest = createLatestOnly();
    const got = await latest.run(
      async () => {
        // Tauri rejects with a plain string, which is most of what this sees.
        throw "repo root does not exist";
      },
      1000,
      "too slow",
    );
    expect(got).toEqual({ kind: "failed", message: "repo root does not exist" });
  });

  test("the bound does not fire once the work has answered", async () => {
    // The timer must be cleared on the happy path too, or every completed
    // check leaves a pending rejection behind it.
    const latest = createLatestOnly();
    const got = await latest.run(async () => "quick", 20, "too slow");
    expect(got).toEqual({ kind: "ok", value: "quick" });
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual({ kind: "ok", value: "quick" });
  });

  test("a run that times out does not stop the next one answering", async () => {
    const latest = createLatestOnly();
    const timedOut = await latest.run(NEVER, 5, "too slow");
    expect(timedOut.kind).toBe("failed");
    expect(await latest.run(async () => "fine", 1000, "too slow")).toEqual({
      kind: "ok",
      value: "fine",
    });
  });
});
