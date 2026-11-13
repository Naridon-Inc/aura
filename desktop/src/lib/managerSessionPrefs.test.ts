// Run with: bun test src/lib/managerSessionPrefs.test.ts
//
// A chat remembers which model and brain its next turn runs on. A pair saved
// on a brain the app no longer offers must read as "nothing chosen" — so the
// chat falls to the brain the app picks — rather than a chip naming a model
// nobody can run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadSessionBrain,
  loadSessionModel,
  saveSessionBrain,
  saveSessionModel,
} from "./managerSessionPrefs";
import type { BrainChoice } from "./api";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const brain = (id: string, label: string): BrainChoice => ({
  id,
  label,
  kind: "native",
  active: false,
  requires_api_key: true,
  has_api_key: true,
});

describe("session model and brain", () => {
  test("a real choice round-trips", () => {
    saveSessionModel("s1", {
      brainId: "cli_wrapper:claude_code",
      modelId: "claude-opus-5",
      longContext: false,
      label: "Opus 5",
      family: "claude",
    });
    saveSessionBrain("s1", brain("cli_wrapper:claude_code", "Claude Code (CLI)"));
    expect(loadSessionModel("s1")?.label).toBe("Opus 5");
    expect(loadSessionBrain("s1")?.id).toBe("cli_wrapper:claude_code");
  });

  test("a pair saved on the retired managed brain reads as nothing, and is forgotten", () => {
    store.set(
      "aura.manager.model.s2",
      JSON.stringify({ brainId: "aura_pro", modelId: "claude-opus-5", label: "Opus 5", family: "claude" }),
    );
    store.set("aura.manager.brain.s2", JSON.stringify(brain("aura_pro", "Managed")));
    expect(loadSessionModel("s2")).toBeNull();
    expect(loadSessionBrain("s2")).toBeNull();
    expect(store.has("aura.manager.model.s2")).toBe(false);
    expect(store.has("aura.manager.brain.s2")).toBe(false);
  });
});
