// Two members installing packages on one box, and whether the screen can tell
// the difference between "yours" and "everybody's".
//
// The failure this guards is quiet in exactly the way the shared-credential one
// is: `npm install -g` succeeds, `cargo install` succeeds, and the person who
// gets broken is the teammate whose version was replaced an hour later. So a
// variable pointing into somebody's home is not the same answer as one pointing
// at `/usr/local`, and an unset variable is only a problem for the one tool
// whose default is machine-wide.

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import type { Scope, ToolchainReport, VarState } from "./toolchain";

const asked: Array<{
  place: { root: string | null; machineId: string | null };
  login?: string;
}> = [];
let answer: ToolchainReport | Error = report();

mock.module("../api", () => ({
  api: {
    placeToolchain: async (
      place: { root: string | null; machineId: string | null },
      login?: string,
    ) => {
      asked.push({ place, login });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
}));

const {
  askToolchain,
  collides,
  collisions,
  separated,
  toolchainSentence,
} = await import("./toolchain");
const { placeHere, placeOfMachine } = await import("./contract");

function v(over: Partial<VarState> = {}): VarState {
  return {
    var: "CARGO_HOME",
    tool: "cargo",
    value: "/home/mo/.cargo",
    scope: { scope: "mine" },
    collides: "a `cargo install` would replace a teammate's binary",
    ...over,
  };
}

function report(over: Partial<ToolchainReport> = {}): ToolchainReport {
  return {
    place: "aura-runner",
    login: "mo",
    home: "/home/mo",
    you: "ubuntu",
    observed: true,
    scoped: true,
    vars: [v()],
    ...over,
  };
}

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "shared",
    repo_path: "/home/ubuntu/aura-src",
    project_root: "/Users/me/alpha",
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

describe("collides", () => {
  test("under the member's own home, nobody is in anybody's way", () => {
    expect(collides({ scope: "mine" })).toBe(false);
  });

  test("a machine-wide path is everybody's, whoever wrote it last", () => {
    expect(collides({ scope: "everybody", path: "/usr/local" })).toBe(true);
  });

  test("inside a teammate's home is the worst one — it looks scoped", () => {
    // Right up until somebody reads the path: it is per-user, just not per-THIS-
    // user, so a member's installs land in a colleague's home.
    expect(collides({ scope: "someone_else", path: "/home/ana/.cargo" })).toBe(
      true,
    );
  });

  test("unset is a collision only for the tool whose default is shared", () => {
    // npm's prefix defaults to /usr/local and needs root; the rest default into
    // the member's own home and are already theirs. Treating all four the same
    // would either cry wolf three times or miss the one that matters.
    const npm: Scope = { scope: "unset", shared_by_default: true };
    const cargo: Scope = { scope: "unset", shared_by_default: false };
    expect(collides(npm)).toBe(true);
    expect(collides(cargo)).toBe(false);
  });
});

describe("what the report says about two members sharing one box", () => {
  test("all-mine is the answer to aim for, and it says so plainly", () => {
    const r = report();
    expect(collisions(r)).toHaveLength(0);
    expect(separated(r)).toBe(true);
    expect(toolchainSentence(r)).toContain("your own home");
    expect(toolchainSentence(r)).toContain("aura-runner");
  });

  test("a shared prefix is named by its tool, not by its variable", () => {
    // The person reading this is about to run `npm install -g`, not to edit
    // their environment, so the sentence has to be about npm.
    const r = report({
      vars: [
        v(),
        v({
          var: "NPM_CONFIG_PREFIX",
          tool: "npm",
          value: "",
          scope: { scope: "unset", shared_by_default: true },
          collides: "a global npm install would replace a teammate's version",
        }),
      ],
    });
    expect(collisions(r).map((c) => c.var)).toEqual(["NPM_CONFIG_PREFIX"]);
    expect(separated(r)).toBe(false);
    const said = toolchainSentence(r);
    expect(said).toContain("npm");
    expect(said).not.toContain("NPM_CONFIG_PREFIX");
    expect(said).toContain("overwrite");
  });

  test("two tools colliding are named once each and read as plural", () => {
    const r = report({
      vars: [
        v({ scope: { scope: "everybody", path: "/usr/local" } }),
        v({
          var: "RUSTUP_HOME",
          tool: "rustup",
          scope: { scope: "everybody", path: "/usr/local/rustup" },
        }),
        v({
          var: "CARGO_TARGET_DIR",
          tool: "cargo",
          scope: { scope: "everybody", path: "/usr/local" },
        }),
      ],
    });
    const said = toolchainSentence(r);
    expect(said).toContain("cargo, rustup");
    expect(said).toContain("keep their state");
  });
});

describe("asking a place rather than a box", () => {
  test("this laptop answers the same question through the same call", async () => {
    asked.length = 0;
    answer = report({ place: "This computer", you: "me", login: "me" });
    const r = await askToolchain(placeHere("/Users/me/alpha"));
    expect(asked[0]).toEqual({
      place: { root: "/Users/me/alpha", machineId: null },
      login: undefined,
    });
    // A local place is a real answer, not an exemption: one member works here,
    // so it is separated by construction and should read that way.
    expect(separated(r)).toBe(true);
  });

  test("a box is asked about one member by name", async () => {
    asked.length = 0;
    answer = report();
    await askToolchain(placeOfMachine(box()), "mo");
    expect(asked[0]).toEqual({
      place: { root: "/Users/me/alpha", machineId: "ubuntu@10.0.0.1" },
      login: "mo",
    });
  });

  test("a place that cannot be reached throws rather than reporting separated", async () => {
    // The dangerous rounding-off: an unreachable box answering "no collisions"
    // would tell a member their installs are their own on the strength of never
    // having looked.
    asked.length = 0;
    answer = new Error("ssh: connect to host 10.0.0.1 port 22: timed out");
    await expect(askToolchain(placeOfMachine(box()), "mo")).rejects.toThrow(
      "timed out",
    );
  });
});
