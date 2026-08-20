// A directory listing shared by the two things that browse directories — and
// what has to happen when the caller is the reason it changed.
//
// The file tree and the composer's @-file popup walk the same folders. Sharing
// an in-flight read between them is free. But `reloadFolder` in the tree runs
// *because* somebody just created, renamed or deleted a file, and joining a
// read that started before that write shows them the folder without their
// change in it — which looks exactly like the write having failed. That is what
// `reloadDirList` is for, and the epoch it bumps is what stops the pre-change
// read, still in flight, from landing on top of the post-change one afterwards.

import { describe, expect, it, beforeEach, mock } from "bun:test";

let calls = 0;
// Each queued gate lets one listDir call be held open and released on demand,
// so a slow pre-change read can be made to resolve *after* a fast later one.
let gates: Array<{ promise: Promise<void>; settle: () => void }> = [];
let payloads: string[][] = [];
// Call indexes that should reject rather than list.
let failAt = new Set<number>();

function gate() {
  let settle!: () => void;
  const promise = new Promise<void>((res) => {
    settle = res;
  });
  return { promise, settle: () => settle() };
}

mock.module("../src/lib/api", () => ({
  api: {
    listDir: async (_absPath: string) => {
      const i = calls;
      calls += 1;
      const g = gates[i];
      if (g) await g.promise;
      if (failAt.has(i)) throw new Error("EACCES");
      const names = payloads[i] ?? ["a.ts"];
      return names.map((name) => ({
        name,
        path: `/repo/${name}`,
        is_dir: false,
      }));
    },
  },
}));

const { loadDirList, reloadDirList, peekDirList, warmDirList } = await import(
  "../src/lib/dirListCache"
);

const names = (entries: Array<{ name: string }> | undefined) =>
  entries?.map((e) => e.name);

describe("one listing per directory, shared", () => {
  beforeEach(() => {
    calls = 0;
    gates = [];
    payloads = [];
    failAt = new Set();
  });

  it("two readers of one directory share the round trip", async () => {
    gates = [gate()];
    const a = loadDirList("/repo/shared-1");
    const b = loadDirList("/repo/shared-1");
    gates[0].settle();
    expect(names(await a)).toEqual(names(await b));
    expect(calls).toBe(1);
  });

  it("a resolved listing is there to paint from next time", async () => {
    payloads = [["one.ts", "two.ts"]];
    await loadDirList("/repo/warm-1");
    expect(names(peekDirList("/repo/warm-1"))).toEqual(["one.ts", "two.ts"]);
  });

  it("a settled read does not answer the next asker. Only an in-flight one does", async () => {
    // No window here on purpose: a folder is a live thing. Sharing is only ever
    // between calls overlapping in time, so a second visit re-reads.
    await loadDirList("/repo/nowindow-1");
    await loadDirList("/repo/nowindow-1");
    expect(calls).toBe(2);
  });

  it("warming skips a directory that is already known", async () => {
    await loadDirList("/repo/warm-2");
    warmDirList("/repo/warm-2");
    expect(calls).toBe(1);
  });

  it("a failed read leaves nothing behind to paint", async () => {
    // Distinct from an empty directory, which is a real answer. Nothing must be
    // written, so the next caller does a real read rather than inheriting a
    // dead promise.
    const boom = mock(() => Promise.reject(new Error("EACCES")));
    const original = (await import("../src/lib/api")).api.listDir;
    (await import("../src/lib/api")).api.listDir = boom as never;
    await expect(loadDirList("/repo/denied-1")).rejects.toThrow("EACCES");
    expect(peekDirList("/repo/denied-1")).toBeUndefined();
    (await import("../src/lib/api")).api.listDir = original;
    await loadDirList("/repo/denied-1");
    expect(peekDirList("/repo/denied-1")).toBeDefined();
  });
});

describe("the caller that changed the directory", () => {
  beforeEach(() => {
    calls = 0;
    gates = [];
    payloads = [];
    failAt = new Set();
  });

  it("does not join the read that started before the change", async () => {
    gates = [gate(), gate()];
    payloads = [["before.ts"], ["before.ts", "created.ts"]];

    const stale = loadDirList("/repo/created-1"); // started pre-write
    const afterWrite = reloadDirList("/repo/created-1"); // the tree re-listing
    gates[1].settle();

    expect(names(await afterWrite)).toEqual(["before.ts", "created.ts"]);
    expect(calls).toBe(2);
    gates[0].settle();
    await stale;
  });

  it("and the older read cannot land on top of the newer one", async () => {
    // The ordering that actually bites: the pre-change read is slow, so it
    // resolves last. Without the epoch it would overwrite the listing the user
    // is looking at with the one from before their file existed.
    gates = [gate(), gate()];
    payloads = [["before.ts"], ["before.ts", "created.ts"]];

    const stale = loadDirList("/repo/created-2");
    const afterWrite = reloadDirList("/repo/created-2");
    gates[1].settle();
    await afterWrite;
    gates[0].settle();
    await stale;

    expect(names(peekDirList("/repo/created-2"))).toEqual([
      "before.ts",
      "created.ts",
    ]);
  });

  it("a read that fails after being replaced doesn't clear its replacement", async () => {
    // The superseded read is the one that fails, and it fails last. If its
    // catch cleared the in-flight slot without checking whose it is, the next
    // caller would start a third read of a directory already being read — the
    // duplicate this module exists to prevent, reappearing only on the error
    // path where nobody looks.
    gates = [gate(), gate()];
    failAt = new Set([0]);

    const doomed = loadDirList("/repo/superseded-1");
    const replacement = reloadDirList("/repo/superseded-1");
    gates[0].settle();
    await expect(doomed).rejects.toThrow("EACCES");

    const joiner = loadDirList("/repo/superseded-1");
    gates[1].settle();
    await replacement;
    await joiner;
    expect(calls).toBe(2);
  });

  it("still shares reads that start after the change", async () => {
    // The epoch invalidates what came before, not the cache itself: two
    // surfaces re-listing the same folder after one write still ask once.
    gates = [gate()];
    const a = reloadDirList("/repo/created-3");
    const b = loadDirList("/repo/created-3");
    gates[0].settle();
    await a;
    await b;
    expect(calls).toBe(1);
  });
});
