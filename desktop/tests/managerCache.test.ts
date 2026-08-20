// Listing Aura's conversations deserialises every transcript on disk.
//
// `manager_list` returns summary rows, which reads as cheap and is not: for
// every conversation not currently live in memory it loads the persisted
// session whole — objective, projects and the entire message history — to
// build one row. Seven call sites ask for it, several inside the same moment
// of opening a workspace.
//
// No freshness window here either (see tasksCache.test.ts for the argument):
// the surfaces that list conversations are the surfaces that start, append to
// and cancel them, and they re-read straight afterwards.

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

describe("who lists conversations", () => {
  it("is only the cache module. Everyone else goes through it", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/managerCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.managerList(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps no freshness window", async () => {
    const src = stripComments(await readSrc("lib/managerCache.ts"));
    expect(src).toContain("const COALESCE_ONLY = 0;");
    expect(src).toContain("COALESCE_ONLY,");
  });
});

describe("the reader itself", () => {
  beforeEach(() => {
    mock.restore();
  });

  async function withCounter() {
    const seen: Array<string | null> = [];
    mock.module("../src/lib/api", () => ({
      api: {
        managerList: async (repoRoot?: string | null) => {
          seen.push(repoRoot ?? null);
          return [{ id: `s${seen.length}` }];
        },
      },
    }));
    const mod = await import("../src/lib/managerCache");
    return { seen, ...mod };
  }

  it("collapses the surfaces that ask at boot into one read", async () => {
    const { seen, fetchManagerList } = await withCounter();
    const before = seen.length;
    await Promise.all([
      fetchManagerList("/repo"),
      fetchManagerList("/repo"),
      fetchManagerList("/repo"),
    ]);
    expect(seen.length - before).toBe(1);
  });

  it("keeps the every-workspace list apart from a project's", async () => {
    const { seen, fetchManagerList } = await withCounter();
    const before = seen.length;
    await Promise.all([fetchManagerList(), fetchManagerList("/repo")]);
    // The store's unscoped refresh asks about every workspace; a scoped read
    // must not be answered with it, or a project shows conversations that
    // belong to another one.
    expect(seen.length - before).toBe(2);
    expect(seen.slice(before).sort()).toEqual(["/repo", null].sort() as never);
  });

  it("still reads again right after a conversation is started", async () => {
    const { seen, fetchManagerList } = await withCounter();
    const before = seen.length;
    await fetchManagerList("/repo");
    await fetchManagerList("/repo");
    expect(seen.length - before).toBe(2);
  });

  it("does not answer a failed read with 'no conversations'", async () => {
    mock.module("../src/lib/api", () => ({
      api: {
        managerList: async () => {
          throw new Error("session store unreadable");
        },
      },
    }));
    const { fetchManagerList } = await import("../src/lib/managerCache");
    expect(fetchManagerList("/repo")).rejects.toThrow(
      "session store unreadable",
    );
    await fetchManagerList("/repo").catch(() => {});
  });
});
