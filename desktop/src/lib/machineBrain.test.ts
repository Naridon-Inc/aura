import { describe, expect, test } from "bun:test";

import type { BrainChoice } from "./api";
import { claudeSeed, isMachineBrain, machineCatalog, machineEngine, turnModel } from "./machineBrain";
import { catalogFor, type SelectedModel } from "./modelCatalog";
import { catalogOptions } from "../components/chat/model/catalogOptions";

const machine: BrainChoice = {
  id: "place:ws-1",
  label: "Claude on aura-runner",
  kind: "acp",
  active: false,
  requires_api_key: false,
  has_api_key: true,
};

const picked = (brainId: string, modelId: string): SelectedModel => ({
  brainId,
  modelId,
  longContext: false,
  label: modelId,
  family: "generic",
});

describe("a chat on one of the org's machines", () => {
  test("is known by its brain", () => {
    expect(isMachineBrain(machine)).toBe(true);
    expect(isMachineBrain({ id: "anthropic" })).toBe(false);
    expect(isMachineBrain(null)).toBe(false);
  });

  test("carries only a model of that machine", () => {
    expect(turnModel(machine, picked("place:ws-1", "opus"))?.modelId).toBe("opus");
    expect(turnModel(machine, picked("anthropic", "claude-opus-4"))).toBeNull();
    expect(turnModel(machine, null)).toBeNull();
    const local = picked("anthropic", "claude-opus-4");
    expect(turnModel(null, local)).toBe(local);
  });

  test("offers what its agent reported, and nothing from this laptop", () => {
    const rows = catalogFor(
      machine,
      machineCatalog(machine, [
        { id: "default", label: "Default (recommended)" },
        { id: "opus", label: "Opus" },
      ]),
    );
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ["default", "Default (recommended)"],
      ["opus", "Opus"],
    ]);
  });

  test("its picker lists Auto on the machine, then the machine's models, and nothing else", () => {
    const { options, loadout } = catalogOptions({
      brains: [machine],
      live: machineCatalog(machine, [{ id: "opus", label: "Opus" }]),
      // The laptop's loadout names laptop brains; none of it shows here.
      favorites: [],
      auto: { name: "Auto", provider: machine.label },
      efforts: true,
      fast: true,
    });
    expect(loadout).toEqual([]);
    expect(options.map((o) => [o.name, o.provider])).toEqual([
      ["Auto", "Claude on aura-runner"],
      ["Opus", "Claude on aura-runner"],
    ]);
  });

  test("is told apart by the agent its label names", () => {
    expect(machineEngine(machine)).toBe("claude");
    expect(machineEngine({ ...machine, label: "Codex on aura-runner" })).toBe("codex");
  });

  test("before its agent reports, a Claude machine lists the Claude Code models", () => {
    const rows = catalogFor(machine, machineCatalog(machine, []));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("claude-haiku-4-5-20251001");
    // Auto stands in for the agent's default, and a 1M row would be its model twice.
    expect(ids).not.toContain(null);
    expect(rows.some((r) => r.longContext)).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.every((r) => r.brand === "claude")).toBe(true);
  });

  test("names those models from this laptop's live catalog when it has one", () => {
    const live = {
      fetched_at: 1,
      cached: false,
      families: {
        anthropic: [
          { key: "opus-9", id: "claude-opus-9", label: "Opus 9" },
          { key: "opus-9-1m", id: "claude-opus-9", label: "Opus 9 1M", longContext: true },
        ],
      },
      errors: {},
    };
    expect(claudeSeed(live).map((r) => [r.id, r.label])).toEqual([["claude-opus-9", "Opus 9"]]);
    const rows = catalogFor(machine, machineCatalog(machine, [], live));
    expect(rows.map((r) => r.label)).toEqual(["Opus 9"]);
  });

  test("once its agent reports, the agent's list is the list", () => {
    const rows = catalogFor(machine, machineCatalog(machine, [{ id: "opus", label: "Opus" }]));
    expect(rows.map((r) => [r.id, r.label, r.brand])).toEqual([["opus", "Opus", "claude"]]);
  });

  test("a Codex machine offers only its agent's default until the agent reports", () => {
    const codex = { ...machine, label: "Codex on aura-runner" };
    const rows = catalogFor(codex, machineCatalog(codex, []));
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(rows.every((r) => r.id === null || r.id === "default")).toBe(true);
  });

  test("its picker lists Auto, then the Claude Code models, while the agent starts", () => {
    const { options } = catalogOptions({
      brains: [machine],
      live: machineCatalog(machine, []),
      favorites: [],
      auto: { name: "Auto", provider: machine.label },
      efforts: true,
      fast: true,
    });
    const names = options.map((o) => o.name);
    expect(names[0]).toBe("Auto");
    expect(names).toContain("Opus 5");
    expect(names).not.toContain("Default");
    expect(options.every((o) => o.provider === machine.label)).toBe(true);
  });
});
