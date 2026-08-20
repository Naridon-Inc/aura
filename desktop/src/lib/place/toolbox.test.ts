import { describe, expect, mock, test } from "bun:test";

import type { Installed, ToolAsk } from "./toolbox";

type Ask = {
  place: { root: string | null; machineId: string | null };
  home: string;
  ask: ToolAsk;
  login?: string;
};

const asks: Ask[] = [];
let answer: Installed = {
  login: "mo",
  home: "/home/mo",
  tool: "cowsay",
  state: "installed",
  at: "/home/mo/.npm-global/bin/cowsay",
  mine: true,
};

mock.module("../api", () => ({
  api: {
    placeInstallForMe: (
      place: { root: string | null; machineId: string | null },
      home: string,
      ask: ToolAsk,
      login?: string,
    ) => {
      asks.push({ place, home, ask, login });
      return Promise.resolve(answer);
    },
  },
}));

const { installForMe, installWorked, installedSentence } = await import("./toolbox");

const place = (machineId: string | null) => ({
  kind: machineId ? ("box" as const) : ("here" as const),
  machineId,
  identity: { host: machineId ? "box.example" : null, user: "mo", kind: "ssh" },
  project: { root: "/Users/mo/code/aura", name: "aura" },
  capabilities: { agents: [], git: true, tmux: true, aura: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

describe("installing something for just me", () => {
  test("the ask carries whose home it goes in, on both place-modes", async () => {
    // The governing rule, on this side: one call shape, so an install cannot be
    // arranged for one way of getting a place and not the other.
    asks.length = 0;
    await installForMe(place(null), "/Users/mo", { manager: "npm", name: "cowsay" }, "mo");
    await installForMe(place("box-1"), "/home/mo", { manager: "npm", name: "cowsay" }, "mo");
    expect(asks).toHaveLength(2);
    expect(asks[0].place.machineId).toBeNull();
    expect(asks[1].place.machineId).toBe("box-1");
    // The home is the one ON that place, not this Mac's idea of it.
    expect(asks[0].home).toBe("/Users/mo");
    expect(asks[1].home).toBe("/home/mo");
    for (const a of asks) expect(a.login).toBe("mo");
    // And both were handed the place rather than a machine id with a null check
    // in front of it.
    for (const a of asks) expect(a.place.root).toBe("/Users/mo/code/aura");
  });

  test("a version and a differently-named binary reach the backend intact", async () => {
    asks.length = 0;
    await installForMe(place("box-1"), "/home/mo", {
      manager: "npm",
      name: "@anthropic-ai/claude-code",
      version: "1.2.3",
      bin: "claude",
    });
    expect(asks[0].ask).toEqual({
      manager: "npm",
      name: "@anthropic-ai/claude-code",
      version: "1.2.3",
      bin: "claude",
    });
  });

  test("an install into the member's own home is the one that reads as done", () => {
    const got: Installed = {
      login: "mo",
      home: "/home/mo",
      tool: "cowsay",
      state: "installed",
      at: "/home/mo/.npm-global/bin/cowsay",
      mine: true,
    };
    expect(installWorked(got)).toBe(true);
    expect(installedSentence(got)).toContain("in mo's own home");
    // The sentence a shared box needs: the teammate in the next tmux window
    // wasn't touched, and the member should be told so rather than left to
    // wonder.
    expect(installedSentence(got)).toContain("Nobody else here is changed");
  });

  test("a tool that was already theirs is not reported as a fresh install", () => {
    const got: Installed = {
      login: "mo",
      home: "/home/mo",
      tool: "cowsay",
      state: "already",
      at: "/home/mo/.npm-global/bin/cowsay",
      mine: true,
    };
    expect(installWorked(got)).toBe(true);
    expect(installedSentence(got)).toContain("was already mo's");
  });

  test("landing on the machine's copy is not success, whatever the install said", () => {
    // The acceptance criterion catching its own failure. `state: installed` and
    // a path outside the member's home means what runs afterwards is everyone's
    // copy — the exact thing this feature exists to stop — and a surface that
    // said "done" would be reporting the opposite of what happened.
    const shared: Installed = {
      login: "mo",
      home: "/home/mo",
      tool: "cowsay",
      state: "installed",
      at: "/usr/local/bin/cowsay",
      mine: false,
    };
    expect(installWorked(shared)).toBe(false);
    expect(installedSentence(shared)).toContain("the machine's copy");
    expect(installedSentence(shared)).toContain("/usr/local/bin/cowsay");
  });

  test("installed but unreachable is its own sentence, not silence", () => {
    const nowhere: Installed = {
      login: "mo",
      home: "/home/mo",
      tool: "cowsay",
      state: "installed",
      at: "",
      mine: false,
    };
    expect(installWorked(nowhere)).toBe(false);
    expect(installedSentence(nowhere)).toContain("nothing on mo's PATH can run it");
  });

  test("what the backend says is what is rendered, not what was asked for", async () => {
    // A place that installed for somebody else must not be rendered as this
    // member's install because this member is who we asked for.
    answer = {
      login: "ubuntu",
      home: "/home/ubuntu",
      tool: "cowsay",
      state: "installed",
      at: "/home/ubuntu/.npm-global/bin/cowsay",
      mine: true,
    };
    const got = await installForMe(place("box-1"), "/home/mo", {
      manager: "npm",
      name: "cowsay",
    }, "mo");
    expect(got.login).toBe("ubuntu");
    expect(installedSentence(got)).toContain("ubuntu's own home");
  });
});
