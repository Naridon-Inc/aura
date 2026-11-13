import { describe, expect, test } from "bun:test";

import type { BoxProject, PlaceRoster, PlaceRow } from "./api";
import type { CloudMessageRow, CloudWorkspaceRow } from "./cloudWorkspacesApi";
import {
  boxChatSessions,
  branchFor,
  candidatesOf,
  catchUp,
  cutLine,
  historyFor,
  recovered,
  type SeedTurn,
  engineFor,
  githubSlugOf,
  heldOnLog,
  holdFirstPrompt,
  isDriver,
  linkOf,
  pendingKey,
  projectFor,
  sessionFor,
  takeFirstPrompt,
  threadKey,
  withoutMirrors,
  type BoxStore,
} from "./cloudBoxChat";

const place = {
  machine: "aura-runner",
  remote_root: "/home/ubuntu/aura-fix-login",
  branch: "fix-login",
  engine: "claude",
  agent_session_id: null,
  place_id: "p-1",
};

function memory(): BoxStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function project(path: string, remote: string | null): BoxProject {
  return { path, name: path.split("/").pop() ?? path, remote, branch: "main", dirty: false } as BoxProject;
}

function row(over: Partial<PlaceRow>): PlaceRow {
  return {
    id: "m-1",
    name: "aura-runner",
    machine: { id: "m-1" },
    runner_id: "p-1",
    online: true,
    ...over,
  } as PlaceRow;
}

describe("who drives a machine chat", () => {
  test("only the member who linked the workspace to its machine", () => {
    expect(isDriver({ place, place_linked_by: "u-1" }, "u-1")).toBe(true);
    expect(isDriver({ place, place_linked_by: "u-1" }, "u-2")).toBe(false);
  });

  test("nobody, when the workspace has no machine or you aren't known", () => {
    expect(isDriver({ place: null, place_linked_by: "u-1" }, "u-1")).toBe(false);
    expect(isDriver({ place, place_linked_by: "u-1" }, null)).toBe(false);
    expect(isDriver({ place, place_linked_by: null }, "u-1")).toBe(false);
  });

  test("no laptop, once the computer answers by itself", () => {
    expect(isDriver({ place: { ...place, driver: "box" }, place_linked_by: "u-1" }, "u-1")).toBe(false);
  });
});

describe("when this laptop can't open the chat it drives", () => {
  test("a machine out of reach is said plainly, without the ssh text", () => {
    const line = cutLine(
      "aura-runner",
      "the chat could not be read: ssh: connect to host 203.0.113.7 port 22: Operation timed out",
    );
    expect(line).toBe("This laptop can’t reach aura-runner right now, so you’re reading it the way your teammates do.");
    expect(line).not.toContain("203.0.113");
  });

  test("any other failure says what it was", () => {
    expect(cutLine("aura-runner", "no agent on the machine")).toBe(
      "The chat on aura-runner didn’t open here (no agent on the machine), so you’re reading it the way your teammates do.",
    );
    expect(cutLine("aura-runner", "  ")).toContain("(no reason given)");
  });
});

describe("finding the project on a machine", () => {
  test("a GitHub remote reads the same in every spelling", () => {
    expect(githubSlugOf("git@github.com:Owner/Repo.git")).toBe("owner/repo");
    expect(githubSlugOf("https://github.com/owner/repo")).toBe("owner/repo");
    expect(githubSlugOf("https://github.com/owner/repo.git/")).toBe("owner/repo");
    expect(githubSlugOf("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(githubSlugOf("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(githubSlugOf(null)).toBeNull();
  });

  test("the project itself wins over worktrees made beside it", () => {
    const projects = [
      project("/home/ubuntu/aura-fix-login", "git@github.com:owner/aura.git"),
      project("/home/ubuntu/aura", "https://github.com/owner/aura.git"),
      project("/home/ubuntu/other", "https://github.com/owner/other.git"),
    ];
    expect(projectFor(projects, "Owner/Aura")?.path).toBe("/home/ubuntu/aura");
    expect(projectFor(projects, "owner/missing")).toBeNull();
    expect(projectFor(projects, "")).toBeNull();
  });

  test("a machine is offered once, and only when this laptop can reach it", () => {
    const roster = {
      places: [
        row({}),
        row({ id: "m-2", machine: { id: "m-2" } as PlaceRow["machine"] }),
        row({ id: "m-3", machine: null, runner_id: "p-3" }),
        row({ id: "m-4", machine: { id: "m-4" } as PlaceRow["machine"], runner_id: "p-4", online: false }),
        row({ id: "m-5", machine: { id: "m-5" } as PlaceRow["machine"], runner_id: null }),
        row({ id: "m-6", machine: { id: "m-6" } as PlaceRow["machine"], runner_id: "p-6", online: null }),
      ],
    } as PlaceRoster;
    expect(candidatesOf(roster)).toEqual([
      { machineId: "m-1", placeId: "p-1", machineName: "aura-runner" },
      { machineId: "m-6", placeId: "p-6", machineName: "aura-runner" },
    ]);
  });
});

describe("the engine and branch", () => {
  const models = [
    { id: "opus", provider: "Claude Code" },
    { id: "gpt", provider: "Codex" },
    { id: "composer", provider: "Cursor" },
  ];

  test("the chosen model's agent, when a machine chat can run it", () => {
    expect(engineFor(models, "opus")).toBe("claude");
    expect(engineFor(models, "composer")).toBeNull();
    expect(engineFor([], "")).toBe("claude");
  });

  test("a branch named after the work, unique to the workspace", () => {
    const b = branchFor("Fix the login page", "AbC_123-xyz");
    expect(b.endsWith("-abc123")).toBe(true);
    expect(b).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("what this laptop remembers", () => {
  test("a first prompt made of the log's rows names them until it is taken", () => {
    const store = memory();
    holdFirstPrompt(store, "w1", "fix login\n\nand tests", ["r3", "r4"]);
    expect([...heldOnLog(store, "w1")]).toEqual(["r3", "r4"]);
    expect(takeFirstPrompt(store, "w1")).toBe("fix login\n\nand tests");
    expect(heldOnLog(store, "w1").size).toBe(0);
    // A prompt typed fresh carries no rows, even after one that did.
    holdFirstPrompt(store, "w2", "a", ["r1"]);
    holdFirstPrompt(store, "w2", "b");
    expect(heldOnLog(store, "w2").size).toBe(0);
  });

  test("the first prompt is sent once", () => {
    const store = memory();
    holdFirstPrompt(store, "w1", "  build it  ");
    expect(takeFirstPrompt(store, "w1")).toBe("build it");
    expect(takeFirstPrompt(store, "w1")).toBeNull();
    holdFirstPrompt(store, "w2", "   ");
    expect(takeFirstPrompt(store, "w2")).toBeNull();
  });

  test("a remembered session is picked up while it still loads", async () => {
    const store = memory();
    store.setItem(threadKey("w1"), "s-old");
    let started = 0;
    const deps = { store, alive: async () => true, start: async () => `s-${++started}` };
    const at = { repoRoot: "/r", machineId: "m-1", title: "t", brain: "place:ws-w1" };
    expect(await sessionFor("w1", at, deps)).toEqual({ sessionId: "s-old", resumed: true });
    expect(started).toBe(0);
  });

  test("a session that no longer loads is replaced and the new one remembered", async () => {
    const store = memory();
    store.setItem(threadKey("w1"), "s-gone");
    const asked: string[][] = [];
    const deps = {
      store,
      alive: async () => false,
      start: async (r: string, t: string, m: string, b: string) => {
        asked.push([r, t, m, b]);
        return "s-new";
      },
    };
    const at = { repoRoot: "/r", machineId: "m-1", title: "Fix", brain: "place:ws-w1" };
    const got = await sessionFor("w1", at, deps);
    expect(got).toEqual({ sessionId: "s-new", resumed: false });
    // Born on the machine's agent, so the desktop keeps it off the cloud's
    // session list: the workspace is its one row on Home.
    expect(asked).toEqual([["/r", "Fix", "m-1", "place:ws-w1"]]);
    expect(store.getItem(threadKey("w1"))).toBe("s-new");
  });
});

test("the row's place is handed to the desktop in the shape it reads", () => {
  expect(linkOf(place)).toEqual({
    machine: "aura-runner",
    remoteRoot: "/home/ubuntu/aura-fix-login",
    branch: "fix-login",
    engine: "claude",
    agentSessionId: null,
    placeId: "p-1",
    driver: null,
  });
  // A re-link keeps a computer that answers by itself in that mode.
  expect(linkOf({ ...place, driver: "box" }).driver).toBe("box");
});

function said(id: string, role: string, body: string, at = "2026-11-10T10:00:00Z"): CloudMessageRow {
  return { id, role, body, source: "box-chat", created_at: at };
}

describe("what a laptop never saw", () => {
  const q1 = said("m1", "user", "Fix login");
  const a1 = said("m2", "assistant", "Fixed it.");
  const q2 = said("m3", "user", "Now add a test", "2026-11-10T10:05:00Z");

  test("an answer that finished with the lid closed fills the question left open", () => {
    expect(recovered([q1, a1, q2], { answers: ["Fixed it.", "Added one."], busy: false })).toEqual([
      { question: q2, answer: "Added one." },
    ]);
  });

  test("nothing is filled while the agent is still on the question, or from answers already kept", () => {
    expect(recovered([q1, a1, q2], { answers: ["Fixed it.", "old"], busy: true })).toEqual([]);
    expect(recovered([q1, a1, q2], { answers: [" Fixed it. "], busy: false })).toEqual([]);
    expect(recovered([q1, a1], { answers: ["Fixed it.", "stray"], busy: false })).toEqual([]);
    expect(recovered([], { answers: ["x"], busy: false })).toEqual([]);
  });

  test("the log is filed as the chat, each recovered answer after its question", () => {
    const fills = [{ question: q2, answer: "Added one." }];
    const turns = historyFor([q1, a1, said("n", "system", "x"), q2], fills);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Fix login"],
      ["assistant", "Fixed it."],
      ["user", "Now add a test"],
      ["assistant", "Added one."],
    ]);
    expect(turns[0].at).toBe(Date.parse("2026-11-10T10:00:00Z") / 1000);
  });

  function deps(rows: CloudMessageRow[], answers: string[]) {
    const kept: [string, string][] = [];
    const filed: [SeedTurn[], string | null][] = [];
    let read = 0;
    return {
      kept,
      filed,
      reads: () => read,
      deps: {
        messages: async () => rows,
        answers: async () => {
          read += 1;
          return { answers, busy: false };
        },
        keep: async (_w: string, text: string, key: string) => kept.push([text, key]),
        backfill: async (_s: string, turns: SeedTurn[], after: string | null) => {
          filed.push([turns, after]);
          return true;
        },
      },
    };
  }

  const at = { workspaceId: "ws-1", place, sessionId: "s-1", provider: "place:ws-1" };

  test("a new copy gets the whole conversation, the recovered answer kept once on the log", async () => {
    const d = deps([q1, a1, q2], ["Added one."]);
    await catchUp({ ...at, resumed: false }, d.deps);
    expect(d.kept).toEqual([["Added one.", "recovered-m3"]]);
    expect(d.filed).toHaveLength(1);
    expect(d.filed[0][1]).toBeNull();
    expect(d.filed[0][0].map((t) => t.text)).toEqual(["Fix login", "Fixed it.", "Now add a test", "Added one."]);
  });

  test("a copy this laptop already has gets only the answer, after its question", async () => {
    const d = deps([q1, a1, q2], ["Added one."]);
    await catchUp({ ...at, resumed: true }, d.deps);
    expect(d.filed).toEqual([
      [[{ role: "assistant", text: "Added one.", at: 0, cloud_id: null, cloud_key: "recovered-m3" }], "Now add a test"],
    ]);
  });

  test("each filed turn carries the id of its copy on the log, so its comments find it here", async () => {
    const d = deps([q1, a1, q2], ["Added one."]);
    d.deps.keep = async () => ({ id: "cloud-recovered" });
    await catchUp({ ...at, resumed: false }, d.deps);
    expect(d.filed[0][0].map((t) => [t.cloud_id, t.cloud_key ?? null])).toEqual([
      ["m1", null],
      ["m2", null],
      ["m3", null],
      ["cloud-recovered", "recovered-m3"],
    ]);
  });

  test("a workspace with nothing on its log never reads the machine", async () => {
    const d = deps([], ["x"]);
    await catchUp({ ...at, resumed: false }, d.deps);
    expect(d.reads()).toBe(0);
    expect(d.filed).toEqual([]);
  });

  test("a machine that can't be read still opens the chat with the log", async () => {
    const d = deps([q1, a1, q2], []);
    d.deps.answers = async () => {
      throw new Error("ssh down");
    };
    await catchUp({ ...at, resumed: false }, d.deps);
    expect(d.kept).toEqual([]);
    expect(d.filed[0][0].map((t) => t.text)).toEqual(["Fix login", "Fixed it.", "Now add a test"]);
  });
});


describe("the sessions this laptop shows machine chats in", () => {
  const store = (entries: Record<string, string>) => {
    const keys = Object.keys(entries);
    return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => entries[k] ?? null };
  };
  const row = (id: string, at: CloudWorkspaceRow["place"] = null) => ({ id, place: at }) as CloudWorkspaceRow;

  test("are read from what each workspace remembers, and nothing else", () => {
    const ids = boxChatSessions(
      store({ [threadKey("w1")]: "s-1", [threadKey("w2")]: " ", [pendingKey("w1")]: "hello", "aura.theme": "dark" }),
    );
    expect([...ids]).toEqual(["s-1"]);
  });

  test("their old copies leave the list; a workspace with a machine never does", () => {
    const rows = [row("w1", place), row("s-1"), row("w2")];
    expect(withoutMirrors(rows, new Set(["s-1"])).map((r) => r.id)).toEqual(["w1", "w2"]);
    expect(withoutMirrors([row("s-1", place)], new Set(["s-1"])).map((r) => r.id)).toEqual(["s-1"]);
    expect(withoutMirrors(rows, new Set())).toBe(rows);
  });
});
