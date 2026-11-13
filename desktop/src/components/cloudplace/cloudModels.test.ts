import { describe, expect, test } from "bun:test";

import { cloudModelOptions, harnessesFor, harnessModels, pickerHarnesses } from "./cloudModels";

describe("harnessModels", () => {
  test("Claude Code lists real Claude models by their catalog names", () => {
    const rows = harnessModels("claude");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.provider).toBe("Claude Code");
      expect(r.id).toMatch(/^claude-/);
      expect(r.name).not.toBe(r.id);
      expect(r.name).not.toMatch(/Aura/);
    }
  });

  test("the current Claude family leads, in Claude Code's order", () => {
    const names = harnessModels("claude").map((r) => r.name);
    expect(names.slice(0, 4)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
  });

  test("a model is listed once, without its 1M twin", () => {
    const ids = harnessModels("claude").map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Codex lists OpenAI models", () => {
    const rows = harnessModels("codex");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.provider === "Codex")).toBe(true);
  });

  test("an agent whose models aren't listed offers its own default, sent by name", () => {
    expect(harnessModels("cursor")).toMatchObject([{ id: "cursor", name: "Default", provider: "Cursor" }]);
  });
});

describe("cloudModelOptions", () => {
  test("no connected agent lists nothing", () => {
    expect(cloudModelOptions(new Set())).toEqual([]);
  });

  test("lists only the connected agents, in setup order", () => {
    const providers = new Set(cloudModelOptions(new Set(["cursor", "claude"])).map((r) => r.provider));
    expect([...providers]).toEqual(["Claude Code", "Cursor"]);
  });
});

describe("harnessesFor", () => {
  test("narrows to one agent only when the member has connected it", () => {
    const connected = new Set(["claude", "codex"] as const);
    expect([...harnessesFor(connected, "claude")]).toEqual(["claude"]);
    expect([...harnessesFor(new Set(["codex"] as const), "claude")]).toEqual([]);
    expect(harnessesFor(connected)).toBe(connected);
  });
});

describe("pickerHarnesses", () => {
  test("a teammate sending to a computer-run workspace sees its models without connecting their own", () => {
    const none = new Set<never>();
    expect([...pickerHarnesses(none, "claude", true)]).toEqual(["claude"]);
    expect([...pickerHarnesses(none, "claude", false)]).toEqual([]);
    expect([...pickerHarnesses(new Set(["claude"] as const), "claude")]).toEqual(["claude"]);
    const connected = new Set(["codex"] as const);
    expect(pickerHarnesses(connected, undefined, true)).toBe(connected);
  });
});
