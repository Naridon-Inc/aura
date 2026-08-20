// Five surfaces asked the crew graph the same question on five cadences.
//
// `loop_ready_view` re-arms any node an app left `working` when it died, so it
// writes before it answers. BuildNav polls it every 10s, the work rail every
// 30s, the crew board every 4s while an agent is running — and those cadences
// are not aligned, so the overlaps land exactly when somebody is watching their
// crew work.
//
// Why there is no freshness window here is the same argument as the task
// board's (see tasksCache.test.ts): the surfaces that read the graph are the
// surfaces that move nodes in it, and they re-read straight afterwards. What is
// pinned below is that the reads in flight together collapse, and that a read
// which arrives a moment later still really happens.

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

describe("who reads the crew graph", () => {
  it("is only the cache module. Everyone else goes through it", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/loopCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.loopReadyView(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps no freshness window", async () => {
    const src = stripComments(await readSrc("lib/loopCache.ts"));
    expect(src).toContain("const COALESCE_ONLY = 0;");
    expect(src).toContain("COALESCE_ONLY,");
  });
});

describe("the reader itself", () => {
  beforeEach(() => {
    mock.restore();
  });

  async function withCounter() {
    const counts = { view: 0 };
    mock.module("../src/lib/api", () => ({
      api: {
        loopReadyView: async () => {
          counts.view += 1;
          return { counts: { working: counts.view } };
        },
      },
    }));
    const mod = await import("../src/lib/loopCache");
    return { counts, ...mod };
  }

  it("collapses the polls that land together into one read", async () => {
    const { counts, fetchReadyView } = await withCounter();
    const before = counts.view;
    await Promise.all([
      fetchReadyView("/repo"),
      fetchReadyView("/repo"),
      fetchReadyView("/repo"),
    ]);
    expect(counts.view - before).toBe(1);
  });

  it("still reads again right after a node is moved", async () => {
    const { counts, fetchReadyView } = await withCounter();
    const before = counts.view;
    await fetchReadyView("/repo");
    // The crew board sets a status and re-reads immediately; a held answer
    // would show the run as not started.
    await fetchReadyView("/repo");
    expect(counts.view - before).toBe(2);
  });

  it("does not answer a failed read with an empty queue", async () => {
    mock.module("../src/lib/api", () => ({
      api: {
        loopReadyView: async () => {
          throw new Error("graph unreadable");
        },
      },
    }));
    const { fetchReadyView } = await import("../src/lib/loopCache");
    // "Nothing is queued" is a real answer and the wrong one to invent.
    expect(fetchReadyView("/repo")).rejects.toThrow("graph unreadable");
    await fetchReadyView("/repo").catch(() => {});
  });
});
