// Sixteen surfaces asked "which agent sessions exist here?" independently.
//
// Each ask is a directory walk over ~/.claude/projects/<repo>/ that opens the
// head and tail of every JSONL transcript. The panes are hidden with a CSS
// class rather than unmounted, so several were doing it at once, for the same
// repo, about the same files — and three of them had grown private caches to
// paper over it, which is the usual sign the shape belongs one level down.
//
// Two claims are worth pinning. That nothing goes around the shared reader
// (one straggler re-opens the walk for everyone), and that the callers who are
// resolving a session that was *just created* read past the freshness window.
// AgentSurface waits 500ms for the CLI to write its first line and then looks
// for that file; an eight-second-old list does not contain it, and the agent
// binds to the wrong transcript or to none.

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { readSrc } from "./support/code";

describe("who reads the session list", () => {
  it("is only the cache module. Everyone else goes through it", async () => {
    const hits: string[] = [];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src`;
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/sessionsCache.ts") continue;
      const src = await Bun.file(`${root}/${rel}`).text();
      if (src.includes("claudeListSessions(")) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("keeps the window under the shortest poll that uses it", async () => {
    // ManagerSurface polls at 12s. A window at or above a caller's own poll
    // interval means that caller shows answers older than it believes.
    const src = await readSrc("lib/sessionsCache.ts");
    const ms = Number(src.match(/const FRESH_MS = ([\d_]+);/)?.[1].replace(/_/g, ""));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(12_000);
  });
});

describe("the callers who cannot accept a cached answer", () => {
  const forced = [
    ["components/agent/AgentSurface.tsx", "binds the session the CLI just wrote"],
    ["components/agent/ResumeDialog.tsx", "lists sessions to resume, on open"],
    ["lib/agentSessionScope.ts", "decides resume-or-start-fresh"],
    ["lib/chatSlashHandler.ts", "resolves the session a slash command acts on"],
  ] as const;

  for (const [file, why] of forced) {
    it(`${file} reads past the window. It ${why}`, async () => {
      const src = await readSrc(file);
      expect(src).toContain("refreshSessions");
      expect(src).not.toContain("fetchSessions(");
    });
  }
});

describe("the reader itself", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("asks once when several surfaces ask together", async () => {
    let calls = 0;
    mock.module("../src/lib/api", () => ({
      api: {
        claudeListSessions: async () => {
          calls++;
          return [{ session_id: "s1" }];
        },
      },
    }));
    const { fetchSessions, invalidateSessions } = await import(
      "../src/lib/sessionsCache"
    );
    invalidateSessions();

    const all = await Promise.all([
      fetchSessions("/repo"),
      fetchSessions("/repo"),
      fetchSessions("/repo"),
    ]);

    expect(calls).toBe(1);
    expect(all[2]).toEqual([{ session_id: "s1" }]);
  });

  it("asks again for a caller that must see a just-created session", async () => {
    let calls = 0;
    mock.module("../src/lib/api", () => ({
      api: {
        claudeListSessions: async () => {
          calls++;
          return [{ session_id: `s${calls}` }];
        },
      },
    }));
    const { fetchSessions, refreshSessions, invalidateSessions } = await import(
      "../src/lib/sessionsCache"
    );
    invalidateSessions();

    await fetchSessions("/repo");
    const fresh = await refreshSessions("/repo");

    expect(calls).toBe(2);
    expect(fresh).toEqual([{ session_id: "s2" }]);
    // And the forced read publishes: the next shared reader gets the new
    // session rather than the list from before it existed.
    expect(await fetchSessions("/repo")).toEqual([{ session_id: "s2" }]);
  });

  it("does not turn a failed walk into an empty history", async () => {
    mock.module("../src/lib/api", () => ({
      api: {
        claudeListSessions: async () => {
          throw new Error("permission denied");
        },
      },
    }));
    const { fetchSessions, invalidateSessions, peekSessions } = await import(
      "../src/lib/sessionsCache"
    );
    invalidateSessions();

    // "You have never run an agent here" and "we could not look" are different
    // answers, and only one of them is safe to render as an empty list.
    expect(fetchSessions("/repo")).rejects.toThrow("permission denied");
    await fetchSessions("/repo").catch(() => {});
    expect(peekSessions("/repo")).toBeUndefined();
  });
});
