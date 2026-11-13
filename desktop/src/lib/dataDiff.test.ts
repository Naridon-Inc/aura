// The reading these pin: a data file's change is told as what happened to the
// things in it — a person added, a field no longer saved, a value that moved
// from one thing to another — never as the generic "updates how this part of
// the project works", and never as a raw key standing in for a sentence.

import { describe, expect, test } from "bun:test";

import { dataFormatOf, parseData } from "./dataParse";
import { describeDataChange, singular } from "./dataDiff";

const teamBefore = JSON.stringify(
  {
    team_id: "t_1",
    repo_root: "/Users/sam/Projects/acme",
    created_at: 1794000000,
    members: [
      {
        email: "sam@example.com",
        name: "Sam",
        handle: "sam",
        commits: 412,
        first_seen: 1790000000,
        last_seen: 1794250000,
        admin: true,
      },
      { email: "rio@example.com", name: "Rio", handle: "rio", admin: false },
      { email: "bot@example.com", name: "bot", handle: "bot", admin: false },
    ],
    collaborators_synced_at: 1794200000,
  },
  null,
  2,
);

const teamAfter = JSON.stringify(
  {
    team_id: "t_1",
    created_at: 1794000000,
    members: [
      { email: "bot@example.com", name: "Helper Agent", handle: "bot", admin: false },
      { email: "sam@example.com", name: "Sam", handle: "sam", admin: true },
      { email: "rio@example.com", name: "Rio", handle: "rio", admin: true },
      { email: "kim@example.com", name: "Kim", handle: "kim", admin: false },
    ],
  },
  null,
  2,
);

describe("a team file", () => {
  const rows = describeDataChange(".aura/team/team.json", teamBefore, teamAfter) ?? [];
  const texts = rows.map((r) => `${r.mark} ${r.text}`);

  test("names the machine-local folder for what it is, with the key beside it", () => {
    expect(rows).toContainEqual({
      mark: "−",
      text: "Removed this computer's folder path",
      key: "repo_root",
    });
  });

  test("matches people by email, so a move reads as a move", () => {
    expect(texts).toContain(
      "~ Helper Agent: moved to the top; name used to “bot” → now “Helper Agent”",
    );
    expect(texts.some((t) => t.includes("removed from members"))).toBe(false);
  });

  test("says which fields a person stopped carrying, in words", () => {
    expect(texts).toContain("~ Sam: stopped saving commit count, first seen and last seen");
  });

  test("a switch reads as turned on, a new person as added", () => {
    expect(texts).toContain("~ Rio: admin turned on");
    expect(texts).toContain("+ Kim added as a member");
  });

  test("a dropped timestamp is named, not quoted", () => {
    expect(texts).toContain("− Removed collaborators synced time");
  });

  test("leaves unchanged fields out entirely", () => {
    expect(rows.some((r) => r.key === "team_id" || r.key === "created_at")).toBe(false);
  });
});

test("records that changed the same way are told once, together", () => {
  const people = (extra: boolean) =>
    JSON.stringify({
      members: ["Ana", "Ben", "Cy", "Dee", "Eli"].map((name) => ({
        email: `${name.toLowerCase()}@example.com`,
        name,
        ...(extra ? { commits: 3, last_seen: 1794250000 } : {}),
      })),
    });
  const rows = describeDataChange("team.json", people(true), people(false));
  expect(rows).toEqual([
    {
      mark: "~",
      text: "Ana, Ben and 3 other members: stopped saving commit count and last seen",
      key: "members",
    },
  ]);
});

describe("values", () => {
  test("a changed value reads used to → now", () => {
    const rows = describeDataChange("app.json", `{"theme":"dark"}`, `{"theme":"light"}`);
    expect(rows).toEqual([{ mark: "~", text: "Theme used to “dark” → now “light”", key: "theme" }]);
  });

  test("never quotes a secret or a token-shaped value", () => {
    const rows =
      describeDataChange(
        "cfg.json",
        `{"api_key":"abc","build":"x"}`,
        `{"api_key":"def","build":"9f8e7d6c5b4a39281706f5e4d3c2b1a0"}`,
      ) ?? [];
    const all = rows.map((r) => r.text).join(" | ");
    expect(all).toContain("Api key changed");
    expect(all).toContain("Build changed");
    expect(all).not.toContain("def");
    expect(all).not.toContain("9f8e7d");
  });

  test("a list of names gains and loses entries by name", () => {
    const rows = describeDataChange("a.json", `{"tags":["a","b"]}`, `{"tags":["b","c"]}`);
    expect(rows?.map((r) => r.text)).toEqual(["Added “c” to tags", "Removed “a” from tags"]);
  });

  test("a formatting-only edit has nothing to say", () => {
    expect(describeDataChange("a.json", `{"a":1,"b":2}`, `{\n  "a": 1,\n  "b": 2\n}`)).toEqual([]);
  });

  test("a file that does not read as data offers no reading", () => {
    expect(describeDataChange("a.json", `{"a":1}`, `{"a":`)).toBeNull();
    expect(describeDataChange("src/main.ts", "", "")).toBeNull();
    expect(describeDataChange("package-lock.json", "{}", `{"a":1}`)).toBeNull();
  });

  test("comments and trailing commas in a settings file are fine", () => {
    const rows = describeDataChange(
      "tsconfig.json",
      `{ // base\n "compilerOptions": { "strict": false, } }`,
      `{ "compilerOptions": { "strict": true } }`,
    );
    expect(rows).toEqual([{ mark: "~", text: "Strict turned on", key: "compilerOptions.strict" }]);
  });
});

describe("toml and yaml", () => {
  test("reads tables and arrays of tables", () => {
    const before = `[package]\nname = "aura"\nversion = "0.20.0"\n\n[[bin]]\nname = "aura"\npath = "src/main.rs"\n`;
    const after = `[package]\nname = "aura"\nversion = "0.20.1" # bump\n\n[[bin]]\nname = "aura"\npath = "src/main.rs"\n\n[[bin]]\nname = "aura-hud"\npath = "src/hud.rs"\n`;
    const rows = describeDataChange("Cargo.toml", before, after);
    expect(rows).toEqual([
      { mark: "~", text: "Version used to “0.20.0” → now “0.20.1”", key: "package.version" },
      { mark: "+", text: "aura-hud added as a bin", key: "bin" },
    ]);
  });

  test("reads block mappings and lists", () => {
    const before = `name: ci\non:\n  push:\n    branches:\n      - main\njobs:\n  test:\n    runs-on: ubuntu-latest\n`;
    const after = `name: ci\non:\n  push:\n    branches:\n      - main\n      - release\njobs:\n  test:\n    runs-on: macos-latest\n`;
    const rows = describeDataChange(".github/workflows/ci.yml", before, after);
    expect(rows).toEqual([
      { mark: "+", text: "Added “release” to branches", key: "on.push.branches" },
      {
        mark: "~",
        text: "Runs on used to “ubuntu-latest” → now “macos-latest”",
        key: "jobs.test.runs-on",
      },
    ]);
  });

  test("yaml lists of mappings pair up by name", () => {
    const yaml = parseData(`steps:\n  - name: build\n    run: make\n  - name: test\n    run: make test\n`, "yaml");
    expect(yaml).toEqual({
      steps: [
        { name: "build", run: "make" },
        { name: "test", run: "make test" },
      ],
    });
  });

  test("gives up on yaml it cannot read faithfully", () => {
    expect(parseData(`base: &b\n  a: 1\nother:\n  <<: *b\n`, "yaml")).toBeUndefined();
  });
});

test("which files read as data", () => {
  expect(dataFormatOf(".aura/team/team.json")).toBe("json");
  expect(dataFormatOf("Cargo.toml")).toBe("toml");
  expect(dataFormatOf("a/b/c.yaml")).toBe("yaml");
  expect(dataFormatOf("src/index.ts")).toBeNull();
});

test("singular", () => {
  expect(singular("members")).toBe("member");
  expect(singular("dependencies")).toBe("dependency");
  expect(singular("team channels")).toBe("team channel");
  expect(singular("status")).toBe("status");
  expect(singular("aliases")).toBe("alias");
});
