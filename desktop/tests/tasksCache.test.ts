// Opening Tasks ran the board's heal passes three times over, per project.
//
// `tasks_list` loads the board and then heals it: sequence ids, the status ↔
// state_id and label ↔ label_id mirror, first-touch of the cycle and module
// catalogs, the legacy sprint fold — writing back whenever one of them changed
// something. Three surfaces ask for it at the same instant (the board, the
// place rail's groups, BuildNav), and under "All projects" each fans out per
// root.
//
// The fix is a coalescer, NOT a cache with a window, and that distinction is
// the thing worth pinning here. Every surface that reads the board also writes
// to it, from about twenty-five mutation sites that each re-read afterwards to
// show you what you just did. A window only has to outlive one of those writes
// to show someone their own change missing.

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

describe("who reads the board", () => {
  const commands = [
    "api.tasksList(",
    "api.taskStatesList(",
    "api.taskLabelsList(",
    "api.tasksCyclesList(",
    "api.tasksModulesList(",
  ];

  it("is only the cache module. Everyone else goes through it", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/tasksCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (commands.some((c) => body.includes(c))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps no freshness window at all", async () => {
    // Not an oversight and not a value to tune up later: see the module
    // header. The board is written to constantly, so an answer held in memory
    // for even a second can be a write that appears not to have happened.
    const src = stripComments(await readSrc("lib/tasksCache.ts"));
    expect(src).toContain("const COALESCE_ONLY = 0;");
    expect(src.match(/sharedReader\(/g)?.length).toBe(5);
    expect(src.match(/COALESCE_ONLY,/g)?.length).toBe(5);
  });
});

describe("the reader itself", () => {
  beforeEach(() => {
    mock.restore();
  });

  async function withCounter() {
    const counts = { tasks: 0 };
    mock.module("../src/lib/api", () => ({
      api: {
        tasksList: async (root: string) => {
          counts.tasks += 1;
          return [{ id: `${root}:${counts.tasks}` }];
        },
        taskStatesList: async () => [],
        taskLabelsList: async () => [],
        tasksCyclesList: async () => [],
        tasksModulesList: async () => [],
      },
    }));
    const mod = await import("../src/lib/tasksCache");
    return { counts, ...mod };
  }

  it("collapses the surfaces that mount together into one read", async () => {
    const { counts, fetchTasks } = await withCounter();
    await Promise.all([
      fetchTasks("/repo"),
      fetchTasks("/repo"),
      fetchTasks("/repo"),
    ]);
    expect(counts.tasks).toBe(1);
  });

  it("still reads again for the next caller, however soon it asks", async () => {
    const { counts, fetchTasks } = await withCounter();
    const before = counts.tasks;
    await fetchTasks("/repo");
    await fetchTasks("/repo");
    // The load-bearing one. A card dragged to another column, or a bulk
    // assign, is followed immediately by a re-read — and it has to see the
    // write, not the board from a moment before it.
    expect(counts.tasks - before).toBe(2);
  });

  it("does not confuse one project's board with another's", async () => {
    const { counts, fetchTasks } = await withCounter();
    const before = counts.tasks;
    const [a, b] = await Promise.all([fetchTasks("/a"), fetchTasks("/b")]);
    expect(counts.tasks - before).toBe(2);
    expect(a[0].id.startsWith("/a:")).toBe(true);
    expect(b[0].id.startsWith("/b:")).toBe(true);
  });

  it("does not answer a failed read with an empty board", async () => {
    mock.module("../src/lib/api", () => ({
      api: {
        tasksList: async () => {
          throw new Error("tasks.json unreadable");
        },
        taskStatesList: async () => [],
        taskLabelsList: async () => [],
        tasksCyclesList: async () => [],
        tasksModulesList: async () => [],
      },
    }));
    const { fetchTasks } = await import("../src/lib/tasksCache");
    // An empty board is a real state — a fresh project — and rendering it for
    // a read that failed tells someone their work is gone.
    expect(fetchTasks("/repo")).rejects.toThrow("tasks.json unreadable");
    await fetchTasks("/repo").catch(() => {});
  });
});
