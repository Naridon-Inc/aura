import { describe, expect, test } from "bun:test";

import type { CloudMessageRow, CloudWorkspaceRow } from "./cloudWorkspacesApi";
import {
  LOCAL_TURNS,
  findLocalProject,
  localTurns,
  moveToLocal,
  planMoveToLocal,
  type MoveToLocalDeps,
  type MoveToLocalRequest,
} from "./moveToLocal";

type Row = Pick<CloudWorkspaceRow, "status" | "branch" | "place" | "moved">;

const box = {
  machine: "team-box",
  remote_root: "/opt/aura-runner/workspaces",
  branch: "fix/login",
  engine: "claude",
  agent_session_id: null,
  place_id: "r-1",
  driver: "box",
  linked_at: "2026-11-12T10:00:00Z",
};
const row = (over: Partial<Row> = {}): Row => ({ status: "running", branch: "fix/login", place: box, moved: null, ...over });
const msg = (over: Partial<CloudMessageRow>): CloudMessageRow => ({
  id: "m",
  role: "user",
  body: "hi",
  source: null,
  created_at: "2026-11-12T10:05:00Z",
  ...over,
});

describe("planMoveToLocal", () => {
  test("a workspace on its own branch, with nothing waiting, can move", () => {
    const answered = [msg({ id: "p" }), msg({ id: "a", role: "assistant", source: "box", answers: "p", body: "done" })];
    expect(planMoveToLocal(row(), "acme/web", answered)).toEqual({ ok: true, branch: "fix/login", repo: "acme/web" });
  });

  test("refused while the computer is still working on a prompt", () => {
    const plan = planMoveToLocal(row(), "acme/web", [msg({ id: "p" })]);
    expect(plan).toEqual({
      ok: false,
      why: "team-box is still working on a prompt. Wait for its answer, then move it, so nothing it pushes is left behind.",
    });
    // A message to teammates isn't a prompt it owes an answer to.
    expect(planMoveToLocal(row(), "acme/web", [msg({ id: "p" })], () => true).ok).toBe(true);
  });

  test("refused once moved, archived, without a branch or without a repository", () => {
    const moved = { to: "local", name: "Sam’s computer", branch: "fix/login", by: "u", at: null };
    expect(planMoveToLocal(row({ moved }), "acme/web", [])).toMatchObject({ ok: false, why: expect.stringContaining("already moved to Sam’s computer") });
    expect(planMoveToLocal(row({ status: "archived" }), "acme/web", []).ok).toBe(false);
    expect(planMoveToLocal(row({ branch: " " }), "acme/web", [])).toMatchObject({ ok: false, why: expect.stringContaining("hasn’t got a branch") });
    expect(planMoveToLocal(row(), null, [])).toMatchObject({ ok: false, why: expect.stringContaining("isn’t on a GitHub repository") });
  });

  test("a workspace no computer has can move whatever its log says", () => {
    expect(planMoveToLocal(row({ place: null }), "acme/web", [msg({ id: "p" })]).ok).toBe(true);
  });
});

describe("localTurns", () => {
  test("the log becomes the chat's turns, a teammate's prompts saying whose they are", () => {
    const turns = localTurns(
      [
        msg({ id: "1", body: "mine", author_id: "u-me", author_name: "Ash" }),
        msg({ id: "2", body: "theirs", author_id: "u-sam", author_name: "Sam" }),
        msg({ id: "3", role: "assistant", body: "answer", source: "box", answers: "2" }),
        msg({ id: "4", role: "assistant", body: "Couldn’t run it", source: "box", answers: "2", failed: true }),
        msg({ id: "5", role: "system", body: "note" }),
        msg({ id: "6", body: "  " }),
      ],
      "u-me",
    );
    expect(turns.map((t) => [t.role, t.text, t.cloud_id])).toEqual([
      ["user", "mine", "1"],
      ["user", "Sam: theirs", "2"],
      ["assistant", "answer", "3"],
    ]);
    expect(turns[0]!.at).toBe(Math.floor(Date.parse("2026-11-12T10:05:00Z") / 1000));
  });

  test("keeps the newest turns when the log is long", () => {
    const rows = Array.from({ length: LOCAL_TURNS + 5 }, (_, i) => msg({ id: `m${i}`, body: `t${i}` }));
    const turns = localTurns(rows, null);
    expect(turns.length).toBe(LOCAL_TURNS);
    expect(turns[0]!.text).toBe("t5");
  });
});

describe("findLocalProject", () => {
  test("the open project whose GitHub origin is the workspace's repository", async () => {
    const origins: Record<string, string> = {
      "/p/other": "git@github.com:acme/api.git",
      "/p/web": "https://github.com/Acme/Web.git",
    };
    const originOf = async (root: string) => {
      if (root === "/p/broken") throw new Error("not a repo");
      return origins[root] ?? null;
    };
    expect(await findLocalProject("acme/web", ["/p/broken", "/p/other", "/p/web"], originOf)).toBe("/p/web");
    expect(await findLocalProject("acme/mobile", ["/p/other", "/p/web"], originOf)).toBeNull();
  });
});

describe("moveToLocal", () => {
  type Call = [string, ...unknown[]];
  function harness(fail: Partial<Record<"bring" | "markMoved" | "startChat", string>> & { filed?: boolean } = {}) {
    const calls: Call[] = [];
    const deps: MoveToLocalDeps = {
      bring: async (root, branch) => {
        calls.push(["bring", root, branch]);
        if (fail.bring) throw new Error(fail.bring);
        return { path: "/p/web-fix-login", branch, created: true, fast_forwarded: false };
      },
      markMoved: async (id, moved) => {
        calls.push(["markMoved", id, moved]);
        if (fail.markMoved) throw new Error(fail.markMoved);
      },
      startChat: async (path, title) => {
        calls.push(["startChat", path, title]);
        if (fail.startChat) throw new Error(fail.startChat);
        return "s-1";
      },
      backfill: async (sid, turns) => {
        calls.push(["backfill", sid, turns.length]);
        return fail.filed ?? true;
      },
      note: async (sid, text) => {
        calls.push(["note", sid, text]);
      },
      forgetMoved: (path) => {
        calls.push(["forgetMoved", path]);
      },
    };
    return { calls, deps };
  }
  const request = (turns = 2): MoveToLocalRequest => ({
    workspaceId: "ws-1",
    branch: "fix/login",
    title: "Login retry",
    projectRoot: "/p/web",
    computer: "Ash’s computer",
    from: "team-box",
    turns: Array.from({ length: turns }, (_, i) => ({ role: "user" as const, text: `t${i}`, at: i })),
  });
  const names = (calls: Call[]) => calls.map((c) => c[0]);

  test("brings the branch, tells the cloud, then copies the conversation into a chat here", async () => {
    const { calls, deps } = harness();
    expect(await moveToLocal(request(), deps)).toEqual({ path: "/p/web-fix-login", sessionId: "s-1", warning: null });
    expect(names(calls)).toEqual(["bring", "markMoved", "forgetMoved", "startChat", "backfill", "note"]);
    expect(calls[1]).toEqual(["markMoved", "ws-1", { name: "Ash’s computer", branch: "fix/login" }]);
    expect(calls[3]).toEqual(["startChat", "/p/web-fix-login", "Login retry"]);
    expect(calls[5]![2]).toBe("Moved here from team-box. The work goes on on this computer, on fix/login.");
  });

  test("no conversation is no chat", async () => {
    const { calls, deps } = harness();
    expect(await moveToLocal(request(0), deps)).toEqual({ path: "/p/web-fix-login", sessionId: null, warning: null });
    expect(names(calls)).toEqual(["bring", "markMoved", "forgetMoved"]);
  });

  test("a branch that can't come here moves nothing", async () => {
    const { calls, deps } = harness({ bring: "fix/login has 2 commits here that GitHub doesn't" });
    await expect(moveToLocal(request(), deps)).rejects.toThrow(
      "Couldn’t bring fix/login to this computer, so nothing was moved: fix/login has 2 commits here that GitHub doesn't",
    );
    expect(names(calls)).toEqual(["bring"]);
  });

  test("a cloud that can't be told says the computer may still push, and makes no chat", async () => {
    const { calls, deps } = harness({ markMoved: "offline." });
    await expect(moveToLocal(request(), deps)).rejects.toThrow(
      "fix/login is on this computer now, in /p/web-fix-login, but the cloud workspace couldn’t be told it moved",
    );
    expect(names(calls)).toEqual(["bring", "markMoved"]);
  });

  test("a chat that can't be copied leaves the move done, with a warning", async () => {
    const { deps } = harness({ startChat: "no chats here." });
    const out = await moveToLocal(request(), deps);
    expect(out.sessionId).toBeNull();
    expect(out.warning).toBe(
      "fix/login is here, but its conversation couldn’t be copied into a chat on this computer: no chats here. It’s kept in the cloud workspace.",
    );
  });

  test("a chat that wouldn't take the turns warns too", async () => {
    const { deps } = harness({ filed: false });
    const out = await moveToLocal(request(), deps);
    expect(out.sessionId).toBe("s-1");
    expect(out.warning).toContain("the chat here already had turns of its own.");
  });
});
