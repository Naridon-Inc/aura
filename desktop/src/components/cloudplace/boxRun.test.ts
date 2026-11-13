import { describe, expect, test } from "bun:test";

import { readRunMemory, runActions, runMemoryKey } from "./boxRun";

describe("runActions", () => {
  test("names a detected script the way a person says it, the chosen one first", () => {
    const got = runActions({
      command: "npm run dev",
      candidates: [
        { command: "npm run start", source: "package.json · start" },
        { command: "npm run dev", source: "package.json · dev" },
      ],
    });
    expect(got.map((a) => a.name)).toEqual(["Dev", "Start"]);
    expect(got[0]).toEqual({ name: "Dev", command: "npm run dev", detail: "package.json · dev" });
  });

  test("nothing detected is nothing offered", () => {
    expect(runActions(null)).toEqual([]);
    expect(runActions({ command: null, candidates: [] })).toEqual([]);
  });

  test("a chosen command no candidate explains is called Run", () => {
    expect(runActions({ command: "make serve", candidates: [] })).toEqual([{ name: "Run", command: "make serve" }]);
  });

  test("two scripts that would share a name stay apart", () => {
    const got = runActions({
      command: null,
      candidates: [
        { command: "npm run dev", source: "package.json · dev" },
        { command: "pnpm --filter web dev", source: "web/package.json · dev" },
        { command: "npm run dev", source: "package.json · dev" },
      ],
    });
    expect(got.map((a) => a.name)).toEqual(["Dev", "Dev (pnpm --filter web dev)"]);
  });

  test("a source with no script name is shown as its command", () => {
    expect(runActions({ command: null, candidates: [{ command: "cargo run", source: "Cargo.toml" }] })[0].name).toBe(
      "cargo run",
    );
  });
});

describe("run memory", () => {
  test("is kept per machine and worktree", () => {
    expect(runMemoryKey("m-1", "/home/u/app-x")).not.toBe(runMemoryKey("m-1", "/home/u/app-y"));
  });

  test("reads only what it wrote", () => {
    expect(readRunMemory(JSON.stringify({ session: "aura-shell-app-1", command: "npm run dev" }))).toEqual({
      session: "aura-shell-app-1",
      command: "npm run dev",
    });
    expect(readRunMemory(null)).toBeNull();
    expect(readRunMemory("{")).toBeNull();
    expect(readRunMemory(JSON.stringify({ session: "", command: "x" }))).toBeNull();
  });
});
