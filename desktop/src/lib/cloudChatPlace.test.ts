import { describe, expect, test } from "bun:test";

import type { BoxProject, PlaceProjects, PlaceRoster, PlaceRow } from "./api";
import type { CloudMessageRow } from "./cloudWorkspacesApi";
import {
  CLONE_PATIENCE_MS,
  cloneOutcome,
  cloneUrlFor,
  computerThatAnswers,
  ensureProject,
  pickComputer,
  readinessNote,
  readinessOf,
  unansweredMine,
  type OrgComputer,
  type ProjectDeps,
} from "./cloudChatPlace";

function placeRow(over: Partial<PlaceRow>): PlaceRow {
  return {
    id: "p1",
    name: "aura-runner",
    source: "both",
    owner: { kind: "org" },
    added_by: { kind: "unknown" },
    may: {},
    machine: { id: "m1", name: "aura-runner", host: "10.0.0.1" },
    runner_id: "r1",
    online: true,
    agents: [],
    added_at: 0,
    last_used_at: 0,
    ...over,
  } as unknown as PlaceRow;
}

function roster(places: PlaceRow[]): PlaceRoster {
  return { places, org: { status: "ok", detail: "", slug: "acme", name: "Acme", my_role: "owner" } };
}

describe("readinessOf — what stands between you and an answered chat", () => {
  test("no agent signed in comes first, whatever the computers", () => {
    expect(readinessOf(roster([placeRow({})]), false)).toEqual({ kind: "no-agent" });
  });

  test("a reachable computer that's up is ready", () => {
    const r = readinessOf(roster([placeRow({})]), true);
    expect(r).toEqual({ kind: "ready", computers: [{ machineId: "m1", placeId: "r1", machineName: "aura-runner" }] });
  });

  test("no computer on the board at all", () => {
    expect(readinessOf(roster([]), true)).toEqual({ kind: "no-computer" });
    // A box only this laptop's book knows isn't the org's computer.
    expect(readinessOf(roster([placeRow({ runner_id: null, online: null })]), true)).toEqual({ kind: "no-computer" });
  });

  test("on the board but down, or out of this laptop's reach, is named", () => {
    expect(readinessOf(roster([placeRow({ online: false })]), true)).toEqual({ kind: "offline", name: "aura-runner" });
    expect(readinessOf(roster([placeRow({ machine: null })]), true)).toEqual({ kind: "unreachable", name: "aura-runner" });
  });

  test("a roster that couldn't be read is unknown, not 'no computer'", () => {
    expect(readinessOf(null, true)).toEqual({ kind: "unknown" });
  });
});

describe("readinessOf — the org's own Aura computer", () => {
  const aura = (stage: OrgComputer["stage"], place_id: string | null = "p-aura"): OrgComputer => ({
    name: "Aura computer",
    stage,
    place_id,
  });

  test("it answers by itself, so a laptop that can't reach it isn't blocked", () => {
    const onBoard = roster([placeRow({ machine: null, online: false })]);
    expect(readinessOf(onBoard, true, aura("asleep"))).toEqual({
      kind: "answers-itself",
      name: "Aura computer",
      placeId: "p-aura",
    });
    expect(readinessOf(roster([]), true, aura("ready"))?.kind).toBe("answers-itself");
    expect(readinessOf(null, true, aura("waking"))?.kind).toBe("answers-itself");
  });

  test("a computer this laptop drives still comes first", () => {
    expect(readinessOf(roster([placeRow({})]), true, aura("ready"))?.kind).toBe("ready");
  });

  test("one still being paid for, failed or going away takes no work", () => {
    for (const stage of ["paying", "failed", "ending", "ended"] as const) {
      expect(readinessOf(roster([]), true, aura(stage))).toEqual({ kind: "no-computer" });
    }
    expect(readinessOf(roster([]), true, aura("ready", null))).toEqual({ kind: "no-computer" });
  });

  test("you still need your own agent", () => {
    expect(readinessOf(roster([]), false, aura("ready"))).toEqual({ kind: "no-agent" });
  });

  test("an unnamed one is called your Aura computer", () => {
    expect(computerThatAnswers({ name: " ", stage: "asleep", place_id: "p" })?.name).toBe("your Aura computer");
  });
});

describe("readinessNote — the one thing that fixes it", () => {
  test("each blocked state names its fix", () => {
    expect(readinessNote({ kind: "no-agent" })).toMatchObject({ fix: "agent", label: "Set up an agent" });
    expect(readinessNote({ kind: "no-computer" })?.label).toBe("Connect a cloud computer");
    expect(readinessNote({ kind: "no-computer" })?.fix).toBe("computer");
    expect(readinessNote({ kind: "offline", name: "box" })?.message).toContain("box is offline");
    expect(readinessNote({ kind: "unreachable", name: "box" })?.fix).toBe("computer");
    expect(readinessNote({ kind: "unknown" })?.fix).toBeNull();
    expect(readinessNote({ kind: "ready", computers: [] })).toBeNull();
    expect(readinessNote({ kind: "answers-itself", name: "Aura computer", placeId: "p" })).toBeNull();
  });
});

describe("cloneOutcome — reading a copy's session", () => {
  test("git's progress, then its closing line", () => {
    expect(cloneOutcome("Cloning into 'app'...\nReceiving objects:  42% (420/1000)")).toEqual({ kind: "copying", percent: 42 });
    expect(cloneOutcome("Cloning into 'app'...")).toEqual({ kind: "copying", percent: null });
    expect(cloneOutcome("Receiving objects: 100%\nCloned. This project is ready to work in.\n$ ")).toEqual({ kind: "done" });
  });

  test("a failure carries git's own reason", () => {
    const text = "Cloning into 'app'...\nfatal: repository 'https://github.com/acme/app.git/' not found\nClone failed — the message above is git's own.";
    expect(cloneOutcome(text)).toEqual({ kind: "failed", reason: "repository 'https://github.com/acme/app.git/' not found" });
    expect(cloneOutcome("Clone failed — the message above is git's own.")).toEqual({
      kind: "failed",
      reason: "git stopped without saying why.",
    });
  });

  test("the address is GitHub's", () => {
    expect(cloneUrlFor(" acme/app ")).toBe("https://github.com/acme/app.git");
  });
});

const computer = { machineId: "m1", placeId: "r1", machineName: "aura-runner" };
const app: BoxProject = { path: "/home/ubuntu/app", name: "app", remote: "https://github.com/acme/app.git", branch: "main", dirty: 0 };

function listing(projects: BoxProject[], withheld: PlaceProjects["withheld"] = []): PlaceProjects {
  return { org: "acme", org_name: "Acme", projects, withheld, narrowed: true };
}

function fakeDeps(screens: string[], lists: PlaceProjects[]) {
  const calls: string[] = [];
  let clock = 0;
  const deps: ProjectDeps = {
    projects: async () => lists.shift() ?? listing([]),
    clone: async (_m, url, dir) => {
      calls.push(`clone ${url} ${dir}`);
      return { name: "aura-clone-app" } as never;
    },
    capture: async () => ({ text: screens.shift() ?? "", captured_at: 0 }),
    stop: async (_m, s) => {
      calls.push(`stop ${s}`);
    },
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls };
}

describe("ensureProject — the project on the computer, put there if needed", () => {
  test("already there: no copy", async () => {
    const { deps, calls } = fakeDeps([], [listing([app])]);
    expect(await ensureProject(computer, "acme/app", deps)).toEqual({ ...computer, project: "/home/ubuntu/app" });
    expect(calls).toEqual([]);
  });

  test("missing: copied with progress, its session closed, then found", async () => {
    const steps: string[] = [];
    const { deps, calls } = fakeDeps(
      ["Receiving objects:  10%", "Cloned. This project is ready to work in."],
      [listing([]), listing([app])],
    );
    const target = await ensureProject(computer, "acme/app", deps, (s) => steps.push(s));
    expect(target.project).toBe("/home/ubuntu/app");
    expect(calls).toEqual(["clone https://github.com/acme/app.git app", "stop aura-clone-app"]);
    expect(steps).toContain("Putting acme/app on aura-runner… 10%");
  });

  test("a failed copy says git's reason", async () => {
    const { deps } = fakeDeps(["fatal: Authentication failed\nClone failed — the message above is git's own."], [listing([])]);
    await expect(ensureProject(computer, "acme/app", deps)).rejects.toThrow("Couldn’t put acme/app on aura-runner: Authentication failed");
  });

  test("a folder Aura won't use isn't copied over", async () => {
    const { deps, calls } = fakeDeps([], [listing([], [{ path: "/home/ubuntu/app", name: "app", reason: "It belongs to another organization." }])]);
    await expect(ensureProject(computer, "acme/app", deps)).rejects.toThrow("has a folder called app");
    expect(calls).toEqual([]);
  });

  test("a slow copy stops being waited for, and isn't stopped", async () => {
    const screens = Array.from({ length: CLONE_PATIENCE_MS / 3000 + 5 }, () => "Receiving objects: 1%");
    const { deps, calls } = fakeDeps(screens, [listing([])]);
    await expect(ensureProject(computer, "acme/app", deps)).rejects.toThrow("taking a while");
    expect(calls.some((c) => c.startsWith("stop"))).toBe(false);
  });
});

describe("pickComputer", () => {
  test("the computer that has the project wins, else the first", async () => {
    const other = { machineId: "m2", placeId: "r2", machineName: "big-box" };
    const projects = async (id: string) => listing(id === "m2" ? [app] : []);
    expect(await pickComputer([computer, other], "acme/app", projects)).toEqual(other);
    expect(await pickComputer([computer, other], "acme/none", projects)).toEqual(computer);
    expect(await pickComputer([], "acme/app", projects)).toBeNull();
  });
});

function row(id: string, role: string, body: string, author_id: string | null = null): CloudMessageRow & { author_id?: string | null } {
  return { id, role, body, created_at: "2026-11-11T10:00:00Z", author_id } as CloudMessageRow & { author_id?: string | null };
}

describe("unansweredMine — what an agent is handed when a computer takes over", () => {
  const toPeople = (b: string) => b.startsWith("@maya");

  test("your messages after the last answer, as one message", () => {
    const rows = [row("1", "user", "old", "me"), row("2", "assistant", "done"), row("3", "user", "fix login", "me"), row("4", "user", "and tests", "me")];
    expect(unansweredMine(rows, "me", null, toPeople)).toEqual({ ids: ["3", "4"], text: "fix login\n\nand tests" });
  });

  test("someone else's and people-only messages aren't yours to send", () => {
    const rows = [row("1", "user", "theirs", "sam"), row("2", "user", "@maya look", "me"), row("3", "user", "mine", "me")];
    expect(unansweredMine(rows, "me", null, toPeople)).toEqual({ ids: ["3"], text: "mine" });
  });

  test("a message with no author is the owner's", () => {
    expect(unansweredMine([row("1", "user", "hi")], "me", "me", toPeople)?.ids).toEqual(["1"]);
    expect(unansweredMine([row("1", "user", "hi")], "me", "sam", toPeople)).toBeNull();
  });

  test("nothing open, or no you, is nothing", () => {
    expect(unansweredMine([row("1", "user", "q", "me"), row("2", "assistant", "a")], "me", null, toPeople)).toBeNull();
    expect(unansweredMine([row("1", "user", "q", "me")], null, null, toPeople)).toBeNull();
  });
});

describe("readinessOf — from a browser", () => {
  const aura = (stage: OrgComputer["stage"]): OrgComputer => ({ name: "Aura computer", stage, place_id: "p-aura" });

  test("only the org's Aura computer answers; a computer a laptop drives doesn't count", () => {
    expect(readinessOf(roster([placeRow({})]), true, aura("ready"), true)?.kind).toBe("answers-itself");
    expect(readinessOf(null, true, aura("asleep"), true)?.kind).toBe("answers-itself");
    expect(readinessOf(roster([placeRow({})]), true, null, true)).toEqual({ kind: "in-the-app" });
    expect(readinessOf(null, true, aura("failed"), true)).toEqual({ kind: "in-the-app" });
  });

  test("no agent of yours still comes first, and in-the-app offers the computer", () => {
    expect(readinessOf(null, false, aura("ready"), true)).toEqual({ kind: "no-agent" });
    expect(readinessNote({ kind: "in-the-app" })).toMatchObject({ fix: "computer", label: "See the cloud computer" });
  });
});
