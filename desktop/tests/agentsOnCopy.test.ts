// "Agent on it" has to mean an agent is on it.
//
// Two surfaces answer that question — the sidebar roster's live lane and the
// Workspaces board's column — and both used to union the live tabs with
// `readPersistedAgents(path)`, whatever it happened to hold. That list is a tab
// RESTORE list: which agent tabs were open the last time this workspace was in
// view. It has no timestamp, no liveness, and nothing prunes it. So a workspace
// last touched in June still claimed an agent in August, and the board counted
// it.
//
// The fix is not to drop persisted agents — a PTY outlives its tab, and the
// daemon's outlives the app, so a backgrounded workspace really can have
// someone working in it. It's to ask whether the session is still alive.

import { describe, expect, it, afterEach } from "bun:test";

/** The persisted roster lives in `localStorage`, which bun's runner has no
 *  business providing. A Map is the whole of the API this reads. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
};

// Imported after the global is in place — `editorStore` reads `localStorage`
// at call time, but keeping the order explicit documents the dependency.
const { agentsOnCopy } = await import("../src/lib/agentsOnCopy");
type LiveAgentTab = import("../src/lib/agentsOnCopy").LiveAgentTab;

const ROOT = "/repos/aura";
const OTHER = "/repos/other";

/** `readPersistedAgents` reads localStorage through `editorStore`; seed it the
 *  same way the app writes it. */
function seedPersisted(
  path: string,
  rows: Array<{
    sessionId: string;
    agentId: string;
    agentLabel: string;
    mode: string;
  }>,
): void {
  localStorage.setItem(`aura.openAgents.${path}`, JSON.stringify(rows));
}

afterEach(() => localStorage.clear());

const TAB: LiveAgentTab = {
  sessionId: "live-1",
  repoRoot: ROOT,
  agentId: "claude",
  agentLabel: "Claude",
  attention: true,
};

describe("who counts as an agent on this copy", () => {
  it("counts a tab open on it right now", () => {
    expect(agentsOnCopy(ROOT, [TAB], new Set())).toEqual([
      {
        sessionId: "live-1",
        agentId: "claude",
        agentLabel: "Claude",
        attention: true,
      },
    ]);
  });

  it("ignores tabs open on a different copy", () => {
    expect(agentsOnCopy(OTHER, [TAB], new Set())).toEqual([]);
  });

  it("counts a backgrounded agent whose PTY is still running", () => {
    seedPersisted(ROOT, [
      { sessionId: "pty-9", agentId: "codex", agentLabel: "Codex", mode: "pty" },
    ]);
    expect(agentsOnCopy(ROOT, [], new Set(["pty-9"]))).toEqual([
      {
        sessionId: "pty-9",
        agentId: "codex",
        agentLabel: "Codex",
        // Attention is a real-time flag off a live tab. A persisted row never
        // carries one, so claiming it would be inventing a nudge.
        attention: false,
      },
    ]);
  });

  it("drops a persisted agent whose session died months ago", () => {
    seedPersisted(ROOT, [
      { sessionId: "pty-old", agentId: "claude", agentLabel: "Claude", mode: "pty" },
    ]);
    expect(agentsOnCopy(ROOT, [], new Set(["pty-9"]))).toEqual([]);
  });

  it("never resurrects a stream or chat tab from persistence", () => {
    // A stream run is a per-turn subprocess in this window's store and a chat
    // tab is a view, not a process. Neither can be running in a workspace you
    // aren't looking at, so a persisted one is a bookmark.
    seedPersisted(ROOT, [
      { sessionId: "s-1", agentId: "claude", agentLabel: "Claude", mode: "stream" },
      { sessionId: "c-1", agentId: "claude", agentLabel: "Claude", mode: "chat" },
    ]);
    expect(agentsOnCopy(ROOT, [], new Set(["s-1", "c-1"]))).toEqual([]);
  });

  it("counts one agent once when it is both open and alive", () => {
    seedPersisted(ROOT, [
      { sessionId: "live-1", agentId: "claude", agentLabel: "Claude", mode: "pty" },
    ]);
    const got = agentsOnCopy(ROOT, [TAB], new Set(["live-1"]));
    expect(got).toHaveLength(1);
    // The live row wins: it's the one carrying attention.
    expect(got[0].attention).toBe(true);
  });

  it("under-reports before the first liveness poll rather than over-reporting", () => {
    // An empty id set is "we haven't asked yet", not "nothing is running".
    // Showing one agent short for a second beats showing seven that aren't
    // there — which is the bug this whole file exists to close.
    seedPersisted(ROOT, [
      { sessionId: "pty-9", agentId: "codex", agentLabel: "Codex", mode: "pty" },
    ]);
    expect(agentsOnCopy(ROOT, [TAB], new Set())).toHaveLength(1);
  });
});
