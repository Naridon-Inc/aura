import { describe, expect, test } from "bun:test";

import type { ChatTurn } from "./api";
import type { BoxOpen } from "./cloudBoxChat";
import type { NewCloudWorkspace } from "./cloudWorkspacesApi";
import {
  cannotReach,
  carriedTurns,
  continueInCloud,
  handoffLines,
  moveToCloud,
  objectiveFor,
  openingNote,
  planHandoff,
  wipMessage,
  wipPaths,
  type ContinueDeps,
  type ContinueRequest,
  type HandoffPlan,
  type MoveDeps,
  type MoveRequest,
} from "./continueInCloud";

const state = (over: Partial<Parameters<typeof planHandoff>[0]> = {}) => ({
  branch: "fix/login",
  ahead: 0,
  behind: 0,
  has_upstream: true,
  uncommitted: 0,
  ...over,
});

const ready = (over: Partial<Parameters<typeof planHandoff>[0]> = {}) => {
  const plan = planHandoff(state(over));
  if (!plan.ok) throw new Error(plan.why);
  return plan;
};

const turn = (role: ChatTurn["role"], text: string, at = 0): ChatTurn => ({ role, text, at });

describe("planHandoff", () => {
  test("a branch already on GitHub needs nothing pushed", () => {
    expect(ready()).toMatchObject({ push: "none", branch: "fix/login" });
  });

  test("commits only this laptop has are pushed first", () => {
    expect(ready({ ahead: 2 })).toMatchObject({ push: "push", ahead: 2 });
  });

  test("a branch GitHub has never seen is published first", () => {
    expect(ready({ has_upstream: false })).toMatchObject({ push: "publish" });
  });

  test("a laptop behind GitHub is fine: the cloud starts from GitHub's copy", () => {
    expect(ready({ behind: 3 })).toMatchObject({ push: "none", behind: 3 });
  });

  test("a branch that moved on both sides is refused until it's pulled", () => {
    const plan = planHandoff(state({ ahead: 1, behind: 2 }));
    expect(plan.ok).toBe(false);
    expect((plan as Extract<HandoffPlan, { ok: false }>).why).toContain("Pull first");
  });

  test("the trunk and a detached checkout are refused", () => {
    expect(planHandoff(state({ branch: "main" })).ok).toBe(false);
    expect(planHandoff(state({ branch: "HEAD" })).ok).toBe(false);
    expect(planHandoff(state({ branch: null })).ok).toBe(false);
  });
});

describe("handoffLines", () => {
  test("uncommitted work is named, never silently left behind", () => {
    const lines = handoffLines(ready({ uncommitted: 3, ahead: 1 }));
    expect(lines).toEqual([
      "1 commit not on GitHub yet is pushed first.",
      "3 files with uncommitted changes stay on this laptop. Commit them first if the cloud should have them.",
    ]);
  });

  test("one uncommitted file reads as one", () => {
    expect(handoffLines(ready({ uncommitted: 1 }))[1]).toBe(
      "1 file with uncommitted changes stays on this laptop. Commit it first if the cloud should have it.",
    );
  });

  test("nothing to push says so", () => {
    expect(handoffLines(ready())).toEqual(["Everything committed is already on GitHub."]);
  });
});

describe("the opening note", () => {
  test("carries the person's and the agent's turns, not system lines, newest last", () => {
    const lines = carriedTurns([
      turn("user", "make login retry"),
      turn("system", "tool ran"),
      turn("manager", "Added a retry in auth.ts"),
      turn("user", "   "),
    ]);
    expect(lines).toEqual(["Me: make login retry", "Agent: Added a retry in auth.ts"]);
  });

  test("keeps the last twelve turns, each trimmed, and drops the oldest to fit", () => {
    const many = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "manager" : "user", `${i} ${"x".repeat(900)}`));
    const lines = carriedTurns(many);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[lines.length - 1]).toStartWith("Agent: 29 ");
    expect(lines.every((l) => l.length <= 608)).toBe(true);
    expect(lines.join("\n\n").length).toBeLessThanOrEqual(6000);
  });

  test("says what it is and what to do next", () => {
    const note = openingNote({ branch: "fix/login", pr: 42, turns: [turn("user", "make login retry")], next: "add a test" })!;
    expect(note).toStartWith("I'm continuing fix/login (pull request #42)");
    expect(note).toContain("It's for context; it isn't a list of things still to do.");
    expect(note).toContain("Me: make login retry");
    expect(note).toEndWith("Next: add a test");
  });

  test("no chat and nothing asked is no message at all", () => {
    expect(openingNote({ branch: "fix/login", pr: null, turns: [], next: " " })).toBeNull();
  });
});

describe("objectiveFor", () => {
  test("names the pull request once", () => {
    expect(objectiveFor("Login retry", "fix/login", 42)).toBe("Login retry (#42)");
    expect(objectiveFor("Login retry #42", "fix/login", 42)).toBe("Login retry #42");
    expect(objectiveFor("", "fix/login", null)).toBe("fix/login");
  });
});

describe("continueInCloud", () => {
  type Call = [string, ...unknown[]];
  function harness(fail: Partial<Record<"push" | "create" | "open", string>> = {}) {
    const calls: Call[] = [];
    const held = new Map<string, string>();
    const deps: ContinueDeps = {
      saveWip: async (path, message) => {
        calls.push(["saveWip", path, message]);
      },
      push: async (path, up) => {
        calls.push(["push", path, up]);
        if (fail.push) throw new Error(fail.push);
      },
      create: async (draft: NewCloudWorkspace) => {
        calls.push(["create", draft]);
        if (fail.create) throw new Error(fail.create);
        return { id: "ws-1" };
      },
      hold: (id, prompt) => {
        held.set(id, prompt);
        calls.push(["hold", id]);
      },
      take: (id) => {
        const v = held.get(id) ?? null;
        held.delete(id);
        calls.push(["take", id]);
        return v;
      },
      open: async (open: BoxOpen) => {
        calls.push(["open", open]);
        if (fail.open) throw new Error(fail.open);
      },
      archive: async (id) => {
        calls.push(["archive", id]);
      },
    };
    return { calls, held, deps };
  }

  const request = (plan = ready({ ahead: 2 }), note: string | null = "hello"): ContinueRequest => ({
    path: "/w/fix-login",
    title: "Login retry",
    pr: 42,
    repo: "acme/web",
    plan,
    target: { machineId: "m1", placeId: "p1", machineName: "build-box", project: "/home/u/web" },
    engine: "claude",
    model: "claude-sonnet",
    authorName: "Ash",
    access: "restricted",
    note,
  });

  test("pushes, makes the workspace on the branch, and starts the chat continuing it", async () => {
    const { calls, held, deps } = harness();
    const out = await continueInCloud(request(), deps);
    expect(out).toEqual({ workspaceId: "ws-1" });
    expect(calls.map((c) => c[0])).toEqual(["push", "create", "hold", "open"]);
    expect(calls[0]).toEqual(["push", "/w/fix-login", false]);
    expect(calls[1][1]).toMatchObject({
      repo: "acme/web",
      branch: "fix/login",
      prompt: null,
      access: "restricted",
      intent: "Continues pull request #42 on fix/login from a laptop",
    });
    expect(calls[3][1]).toMatchObject({ branch: "fix/login", continueBranch: true, project: "/home/u/web", engine: "claude" });
    expect(held.get("ws-1")).toBe("hello");
  });

  test("a branch GitHub has never seen is published with its upstream", async () => {
    const { calls, deps } = harness();
    await continueInCloud(request(ready({ has_upstream: false })), deps);
    expect(calls[0]).toEqual(["push", "/w/fix-login", true]);
  });

  test("nothing to push skips the push; no note holds nothing", async () => {
    const { calls, deps } = harness();
    await continueInCloud(request(ready(), null), deps);
    expect(calls.map((c) => c[0])).toEqual(["create", "open"]);
  });

  test("a push that fails starts nothing in the cloud", async () => {
    const { calls, deps } = harness({ push: "rejected (fetch first)" });
    await expect(continueInCloud(request(), deps)).rejects.toThrow(
      "Couldn’t push fix/login, so nothing was started in the cloud: rejected (fetch first)",
    );
    expect(calls.map((c) => c[0])).toEqual(["push"]);
  });

  test("a chat that doesn't start leaves nothing half-made", async () => {
    const { calls, held, deps } = harness({ open: "GitHub has no branch fix/login" });
    await expect(continueInCloud(request(), deps)).rejects.toThrow("Nothing was started in the cloud. GitHub has no branch fix/login");
    expect(calls.map((c) => c[0])).toEqual(["push", "create", "hold", "open", "take", "archive"]);
    expect(held.size).toBe(0);
  });
});

const carried = (over: Partial<Parameters<typeof planHandoff>[0]> = {}) => {
  const plan = planHandoff(state(over), true);
  if (!plan.ok) throw new Error(plan.why);
  return plan;
};

describe("carrying uncommitted changes", () => {
  test("they travel as a commit, so the branch is pushed even with nothing else to push", () => {
    const plan = carried({ uncommitted: 3 });
    expect(plan).toMatchObject({ wip: true, push: "push" });
  });

  test("nothing uncommitted is no commit", () => {
    expect(carried()).toMatchObject({ wip: false, push: "none" });
  });

  test("left behind when the person says so", () => {
    expect(planHandoff(state({ uncommitted: 2 }), false)).toMatchObject({ ok: true, wip: false, push: "none" });
  });

  test("a branch GitHub has never seen is still published", () => {
    expect(carried({ uncommitted: 1, has_upstream: false })).toMatchObject({ wip: true, push: "publish" });
  });

  test("refused while GitHub has commits this laptop doesn't, so they don't go on a stale base", () => {
    const plan = planHandoff(state({ uncommitted: 2, behind: 1 }), true);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toBe("GitHub has 1 commit on fix/login this laptop doesn’t. Pull first, so your uncommitted changes go on top of it, then move it.");
    // Left behind, the same branch moves: the cloud starts from GitHub's copy.
    expect(planHandoff(state({ uncommitted: 2, behind: 1 }), false).ok).toBe(true);
  });

  test("the lines say the changes go with it, in a commit counted with the others", () => {
    expect(handoffLines(carried({ uncommitted: 3, ahead: 1 }))).toEqual([
      "3 files with uncommitted changes are saved in a work-in-progress commit on fix/login and go with it.",
      "2 commits not on GitHub yet are pushed first.",
    ]);
    expect(handoffLines(carried({ uncommitted: 1 }))[0]).toBe(
      "1 file with uncommitted changes is saved in a work-in-progress commit on fix/login and goes with it.",
    );
  });

  test("the opening note tells the agent the newest commit may be half done", () => {
    const note = openingNote({ branch: "fix/login", pr: null, turns: [], next: "finish it", wip: true })!;
    expect(note).toContain(`The newest commit, "${wipMessage("fix/login")}", holds changes I hadn't committed yet.`);
    expect(openingNote({ branch: "fix/login", pr: null, turns: [], next: "finish it" })).not.toContain("newest commit");
  });

  test("the commit stages every unstaged change, once, and leaves staged ones as they are", () => {
    expect(
      wipPaths([
        { path: "src/a.ts", worktree: "M" },
        { path: "src/new.ts", worktree: "?" },
        { path: "src/gone.ts", worktree: "D" },
        { path: "src/staged.ts", worktree: "" },
        { path: "src/a.ts", worktree: "M" },
        { path: " ", worktree: "M" },
      ]),
    ).toEqual(["src/a.ts", "src/new.ts", "src/gone.ts"]);
  });
});

describe("cannotReach", () => {
  test("only the GitHub App refusals strand a workspace", () => {
    expect(cannotReach("project_not_in_github_app")).toBe(true);
    expect(cannotReach("no_github_app")).toBe(true);
    expect(cannotReach("github_refused")).toBe(false);
    expect(cannotReach(null)).toBe(false);
  });
});

describe("moveToCloud", () => {
  type Call = [string, ...unknown[]];
  type Fail = Partial<Record<"saveWip" | "push" | "create" | "link" | "prompt", string>> & { reach?: string | null };
  function harness(fail: Fail = {}) {
    const calls: Call[] = [];
    const step = async (name: keyof Fail, ...args: unknown[]) => {
      calls.push([name, ...args]);
      const why = fail[name];
      if (why) throw new Error(why);
    };
    const deps: MoveDeps = {
      saveWip: (path, message) => step("saveWip", path, message),
      push: (path, up) => step("push", path, up),
      create: async (draft) => {
        await step("create", draft);
        return { id: "ws-1" };
      },
      reach: async (id, branch) => {
        calls.push(["reach", id, branch]);
        return fail.reach ?? null;
      },
      link: (id, computer, branch) => step("link", id, computer, branch),
      prompt: (id, text, model) => step("prompt", id, text, model),
      archive: async (id) => {
        calls.push(["archive", id]);
      },
    };
    return { calls, deps };
  }

  const request = (plan = carried({ uncommitted: 2, ahead: 1 }), note: string | null = "hello"): MoveRequest => ({
    path: "/w/fix-login",
    title: "Login retry",
    pr: 42,
    repo: "acme/web",
    plan,
    computer: { placeId: "r-1", name: "team-box" },
    model: "claude-sonnet",
    access: null,
    note,
  });
  const names = (calls: Call[]) => calls.map((c) => c[0]);

  test("saves, pushes, makes the workspace, checks GitHub, hands it over, then sends the note", async () => {
    const { calls, deps } = harness();
    expect(await moveToCloud(request(), deps)).toEqual({ workspaceId: "ws-1", warning: null });
    expect(names(calls)).toEqual(["saveWip", "push", "create", "reach", "link", "prompt"]);
    expect(calls[0]).toEqual(["saveWip", "/w/fix-login", wipMessage("fix/login")]);
    expect(calls[1]).toEqual(["push", "/w/fix-login", false]);
    expect(calls[2][1]).toMatchObject({
      repo: "acme/web",
      branch: "fix/login",
      prompt: null,
      intent: "Moved pull request #42 on fix/login from a laptop",
    });
    expect(calls[3]).toEqual(["reach", "ws-1", "fix/login"]);
    // Linked before the note goes, so the computer counts it as its work.
    expect(calls[4]).toEqual(["link", "ws-1", { placeId: "r-1", name: "team-box" }, "fix/login"]);
    expect(calls[5]).toEqual(["prompt", "ws-1", "hello", "claude-sonnet"]);
  });

  test("nothing to save or push and no note: just the workspace and the hand-over", async () => {
    const { calls, deps } = harness();
    await moveToCloud(request(carried(), null), deps);
    expect(names(calls)).toEqual(["create", "reach", "link"]);
  });

  test("a commit that can't be made moves nothing", async () => {
    const { calls, deps } = harness({ saveWip: "nothing added to commit" });
    await expect(moveToCloud(request(), deps)).rejects.toThrow(
      "Couldn’t save your uncommitted changes in a commit, so nothing was moved to the cloud: nothing added to commit",
    );
    expect(names(calls)).toEqual(["saveWip"]);
  });

  test("a push that fails says the changes are kept in the commit here", async () => {
    const { calls, deps } = harness({ push: "rejected (fetch first)" });
    await expect(moveToCloud(request(), deps)).rejects.toThrow(
      "Couldn’t push fix/login, so nothing was moved to the cloud: rejected (fetch first) Your changes are saved in a commit on this laptop.",
    );
    expect(names(calls)).toEqual(["saveWip", "push"]);
  });

  test("a repository GitHub won't let the computer fetch is refused, and the workspace archived again", async () => {
    const { calls, deps } = harness({ reach: "Add acme/web to the Aura GitHub App’s repository access." });
    await expect(moveToCloud(request(), deps)).rejects.toThrow(
      "Nothing was moved to the cloud. Add acme/web to the Aura GitHub App’s repository access.",
    );
    expect(names(calls)).toEqual(["saveWip", "push", "create", "reach", "archive"]);
  });

  test("a hand-over that fails archives the workspace again", async () => {
    const { calls, deps } = harness({ link: "the computer is offline" });
    await expect(moveToCloud(request(), deps)).rejects.toThrow("Nothing was moved to the cloud. the computer is offline");
    expect(names(calls)).toEqual(["saveWip", "push", "create", "reach", "link", "archive"]);
  });

  test("a note that doesn't send leaves the move done, with a warning", async () => {
    const { calls, deps } = harness({ prompt: "timed out." });
    const out = await moveToCloud(request(), deps);
    expect(out.warning).toBe("It’s on team-box, but the opening note didn’t send: timed out. Send it from the workspace.");
    expect(names(calls)).not.toContain("archive");
  });
});
