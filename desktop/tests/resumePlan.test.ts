// What the Resume button is about to do, before anyone presses it.
//
//   bun test ./tests/resumePlan.test.ts
//
// AURA-1366. One button, one sentence, four possible outcomes — and the worst
// of them was invisible. A conversation authored in a worktree that has since
// been deleted is re-homed onto the workspace root by the session lister, and
// `claude --resume <id>` launched from there finds no transcript, reports
// nothing and opens a blank agent. The old popover said it "picks up this exact
// conversation where it left off" over all four.
//
// The line these tests hold: a plan that cannot reopen the conversation must
// never carry the id that would silently try, and must say so in words.

import { describe, expect, it } from "bun:test";

import { planLaunchesAgent, resumePlan } from "../src/lib/resumePlan";

const ROOT = "/Users/me/.aura/worktrees/antigua";
const SIBLING = "/Users/me/.aura/worktrees/zagreb";

/** A transcript as the lister hands it over: the physical project dir is the
 *  one field it cannot rewrite, so it is the one the plan decides on. */
function session(opts: { cwd: string; authoredIn: string; id?: string }) {
  const dir = opts.authoredIn.replace(/[^A-Za-z0-9]/g, "-");
  const id = opts.id ?? "sess-1";
  return {
    session_id: id,
    cwd: opts.cwd,
    file_path: `/Users/me/.claude/projects/${dir}/${id}.jsonl`,
  };
}

describe("reopening a conversation that is really there", () => {
  it("carries the conversation, and says so", () => {
    const plan = resumePlan({
      repoRoot: ROOT,
      session: session({ cwd: ROOT, authoredIn: ROOT }),
    });

    expect(plan.kind).toBe("reopen");
    expect(plan.sessionId).toBe("sess-1");
    expect(plan.cwd).toBe(ROOT);
    expect(plan.verb).toBe("Resume");
    expect(plan.carries).toContain("original request");
    expect(plan.carries).toContain("unfinished");
    // A continuation, not a replay — the distinction a person needs before
    // letting a billed agent loose on the same files a second time.
    expect(plan.carries).toContain("nothing is replayed");
    expect(plan.warning).toBe("");
  });

  it("names the other folder when the work happened somewhere else", () => {
    const plan = resumePlan({
      repoRoot: ROOT,
      session: session({ cwd: SIBLING, authoredIn: SIBLING }),
    });

    expect(plan.kind).toBe("reopen");
    // Launched where the conversation lives, not where the reader is standing.
    expect(plan.cwd).toBe(SIBLING);
    expect(plan.warning).toContain("zagreb");
    expect(plan.warning).toContain("antigua");
  });
});

describe("the folder it ran in is gone", () => {
  it("refuses to call a blank new agent a resumed conversation", () => {
    // The lister re-homes an orphan onto the query root, so `cwd` looks local
    // while the transcript still lives under the deleted worktree's dir.
    const plan = resumePlan({
      repoRoot: ROOT,
      session: session({ cwd: ROOT, authoredIn: "/Users/me/.aura/worktrees/granada" }),
      worktree: "granada",
    });

    expect(plan.kind).toBe("fresh");
    expect(plan.verb).toBe("Start fresh here");
    // The whole point: no id goes to `--resume`, so nothing can quietly try.
    expect(plan.sessionId).toBeNull();
    expect(plan.headline).toContain("not this one carried on");
    expect(plan.warning).toContain("granada");
    expect(plan.warning).toContain("not on this machine any more");
  });

  it("points at what is still readable instead of what is not", () => {
    const plan = resumePlan({
      repoRoot: ROOT,
      session: session({ cwd: ROOT, authoredIn: "/Users/me/Documents/New Git" }),
    });

    expect(plan.carries).toContain("Transcript");
    // No folder name was recorded — say "The folder", never invent one.
    expect(plan.warning).toContain("The folder");
  });
});

describe("runs that are not a CLI conversation", () => {
  it("reopens a native Aura chat as a thread, not as a new agent", () => {
    const plan = resumePlan({
      repoRoot: ROOT,
      session: null,
      managerSessionId: " mgr-9 ",
    });

    expect(plan.kind).toBe("chat");
    expect(plan.sessionId).toBe("mgr-9");
    expect(plan.carries).toContain("no new agent starts");
    expect(planLaunchesAgent(plan)).toBe(false);
  });

  it("says which agent's history Aura cannot reopen, by name", () => {
    const plan = resumePlan({ repoRoot: ROOT, session: null, agentId: "codex" });

    expect(plan.kind).toBe("none");
    expect(plan.verb).toBe("");
    expect(plan.warning).toContain("Codex");
  });

  it("stays quiet about an ordinary run with no conversation recorded", () => {
    const plan = resumePlan({ repoRoot: ROOT, session: null, agentId: "claude" });

    expect(plan.kind).toBe("none");
    expect(plan.warning).toBe("");
    expect(planLaunchesAgent(plan)).toBe(false);
  });
});

describe("which plans cost money", () => {
  it("counts a fresh start as a live agent, because it is one", () => {
    const fresh = resumePlan({
      repoRoot: ROOT,
      session: session({ cwd: ROOT, authoredIn: SIBLING }),
    });

    expect(planLaunchesAgent(fresh)).toBe(true);
  });
});
