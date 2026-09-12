// Pressing Resume twice must not give you two agents on one conversation.
//
//   bun test ./tests/resumeGuard.test.ts
//
// AURA-1366. Two surfaces reopen a past run — the session detail's button and
// the launcher's "pick up where you left off" rows — and each brought its own
// idea of a guard: a local `busy` flag in one, nothing at all in the other.
// Neither could see the other. Open the same conversation from both, or press
// once more while a slow spawn is still in flight, and `claude --resume <id>`
// runs twice: two live agents, same thread, same files, and no sign of it in
// the interface. The claim that already protects auto-resume is held across the
// spawn here for the same reason.
//
// The second thing pinned here is quieter and just as load-bearing: when the
// spawn throws, the caller gets a sentence that says nothing was opened. An
// action that failed must never be reported in words that sound like it worked.

import { describe, expect, it, beforeEach, mock } from "bun:test";

let opens = 0;
let failWith: string | null = null;
let hold: { promise: Promise<void>; settle: () => void } | null = null;
let lastArgs: unknown[] = [];

function gate() {
  let settle!: () => void;
  const promise = new Promise<void>((res) => {
    settle = res;
  });
  return { promise, settle: () => settle() };
}

mock.module("../src/lib/api", () => ({
  api: {
    agentPtyOpen: async (...args: unknown[]) => {
      opens += 1;
      lastArgs = args;
      if (hold) await hold.promise;
      if (failWith !== null) throw new Error(failWith);
      return { id: `pty-${opens}` };
    },
  },
}));

const { startResume, claimKeyFor } = await import("../src/lib/resumeLaunch");

const REPO = "/Users/me/.aura/worktrees/antigua";

beforeEach(() => {
  opens = 0;
  failWith = null;
  hold = null;
  lastArgs = [];
});

describe("two presses, one agent", () => {
  it("turns the second press away while the first is still spawning", async () => {
    hold = gate();
    const first = startResume({ repoRoot: REPO, cwd: REPO, sessionId: "sess-1" });
    const second = await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "sess-1" });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("already_starting");
      // Not an error to apologise for — a thing already happening, said in a
      // way that tells the reader where to look for it.
      expect(second.message).toContain("already opening");
    }

    hold.settle();
    hold = null;
    expect((await first).ok).toBe(true);
    expect(opens).toBe(1);
  });

  it("lets a deliberate second run happen once the first has settled", async () => {
    expect((await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "s" })).ok).toBe(true);
    expect((await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "s" })).ok).toBe(true);
    // The window the claim closes is the burst, not the day.
    expect(opens).toBe(2);
  });

  it("guards a fresh start too, because two of those is also two agents", async () => {
    hold = gate();
    const first = startResume({ repoRoot: REPO, cwd: REPO, sessionId: null });
    const second = await startResume({ repoRoot: REPO, cwd: REPO, sessionId: null });

    expect(second.ok).toBe(false);
    hold.settle();
    hold = null;
    await first;
    expect(opens).toBe(1);
  });

  it("keeps two different conversations out of each other's way", async () => {
    hold = gate();
    const a = startResume({ repoRoot: REPO, cwd: REPO, sessionId: "a" });
    const b = startResume({ repoRoot: REPO, cwd: REPO, sessionId: "b" });

    hold.settle();
    hold = null;
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(opens).toBe(2);
  });

  it("keys a fresh start on the folder it would start in", () => {
    expect(claimKeyFor({ sessionId: "s", cwd: REPO })).toBe("s");
    expect(claimKeyFor({ sessionId: null, cwd: `${REPO}/` })).toBe(`new:${REPO}`);
  });
});

describe("a launch that didn't happen", () => {
  it("says nothing was opened, and hands back no agent", async () => {
    failWith = "spawn claude ENOENT";
    const started = await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "sess-1" });

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.reason).toBe("failed");
      expect(started.message).toContain("Nothing was opened");
      // The raw failure is kept, for the reader who wants to know why.
      expect(started.detail).toContain("ENOENT");
    }
  });

  it("frees the conversation so a retry is possible at all", async () => {
    failWith = "spawn claude ENOENT";
    await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "sess-1" });
    failWith = null;

    const retry = await startResume({ repoRoot: REPO, cwd: REPO, sessionId: "sess-1" });
    expect(retry.ok).toBe(true);
  });
});

describe("what actually gets spawned", () => {
  it("resumes the conversation in the folder the plan chose", async () => {
    const cwd = "/Users/me/.aura/worktrees/zagreb";
    await startResume({ repoRoot: REPO, cwd, sessionId: "sess-9", cols: 96, rows: 32 });

    expect(lastArgs[0]).toBe("claude");
    expect(lastArgs[1]).toBe(cwd);
    expect(lastArgs[4]).toBe("sess-9");
    // forceNew — a second tab, never a reattach to some other live agent.
    expect(lastArgs[5]).toBe(true);
  });

  it("passes no conversation id when the plan says start fresh", async () => {
    await startResume({ repoRoot: REPO, cwd: REPO, sessionId: null });

    // The whole deleted-worktree fix rests on this: no id, so `--resume` is
    // never handed one it cannot resolve.
    expect(lastArgs[4]).toBeUndefined();
  });
});
