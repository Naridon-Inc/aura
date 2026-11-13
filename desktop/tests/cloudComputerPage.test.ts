import { describe, expect, test } from "bun:test";

import type { Machine } from "../src/lib/api";
import type { TeamBase } from "../src/lib/place/teamBase";
import {
  baseEntry,
  durationWord,
  envBlock,
  groupComputers,
  installScript,
} from "../src/components/settings/cloudComputer";

function row(over: Partial<Machine>): Machine {
  return {
    id: "dev@box.example:/srv/app",
    name: "box",
    host: "box.example",
    user: "dev",
    key_path: "~/.ssh/id_ed25519",
    box_kind: "mine",
    repo_path: "/srv/app",
    project_root: "/Users/me/app",
    repo_branch: "main",
    added_at: 0,
    last_used_at: 0,
    ...over,
  } as Machine;
}

function base(over: Partial<TeamBase>): TeamBase {
  return {
    place: "box",
    login: "aura-base",
    home: "/home/aura-base",
    created: false,
    shared: true,
    readable: true,
    scoped: true,
    holds: [],
    carries: [],
    built_version: 0,
    built_digest: "",
    ...over,
  };
}

describe("cloud computer page", () => {
  test("rows on one box fold into one computer, shared boxes first", () => {
    const computers = groupComputers([
      row({}),
      row({ id: "dev@box.example:/srv/api", repo_path: "/srv/api", project_root: "/Users/me/api" }),
      row({ id: "ops@team.example:/srv/app", user: "ops", host: "team.example", name: "team", box_kind: "shared" }),
    ]);
    expect(computers.map((c) => c.key)).toEqual(["ops@team.example", "dev@box.example"]);
    expect(computers[1].repos.map((r) => r.label)).toEqual(["app", "api"]);
    expect(computers[0].shared).toBe(true);
  });

  test("two repositories with one folder name keep apart", () => {
    const [c] = groupComputers([
      row({}),
      row({ id: "dev@box.example:/opt/app", repo_path: "/opt/app" }),
    ]);
    expect(c.repos.map((r) => r.label)).toEqual(["app", "/opt/app"]);
  });

  test("the install script is the [env] tables and nothing else", () => {
    const toml = [
      "[worktree]",
      'setup = "npm ci"',
      "",
      "[env]",
      "version = 2",
      "[env.toolchain]",
      'node = "24"',
      "[[env.package]]",
      'name = "ripgrep"',
      "[review]",
      'instructions = "be kind"',
    ].join("\n");
    expect(envBlock(toml)).toBe(
      ['[env]', 'version = 2', '[env.toolchain]', 'node = "24"', '[[env.package]]', 'name = "ripgrep"'].join("\n"),
    );
    expect(envBlock('[worktree]\nsetup = "env X=1 npm ci"')).toBe("");
    expect(installScript([{ label: "app", text: null }])).toContain("declares no [env] block");
  });

  test("the standing build says the spec, never a time", () => {
    expect(baseEntry([{ label: "app", base: base({}) }], "")).toBeNull();
    const entry = baseEntry(
      [
        { label: "app", base: base({ built_version: 3, built_digest: "abcdef0123456789" }) },
        { label: "api", base: base({}) },
      ],
      "",
    );
    expect(entry?.label).toBe("Built to spec v3");
    expect(entry?.status).toBe("ready");
    expect(entry?.time).toBe("");
    expect(entry?.reason).toBe("1 of 2 repositories built");
    const held = baseEntry(
      [{ label: "app", base: base({ built_version: 1, built_digest: "x", carries: [".ssh/id_rsa"] }) }],
      "",
    );
    expect(held?.status).toBe("failed");
    expect(held?.reason).toContain(".ssh/id_rsa");
  });

  test("durations read as people say them", () => {
    expect(durationWord(42_000)).toBe("42s");
    expect(durationWord(185_000)).toBe("3m 05s");
  });
});
