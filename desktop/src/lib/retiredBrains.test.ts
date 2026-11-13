// Run with: bun test src/lib/retiredBrains.test.ts

import { describe, expect, test } from "bun:test";
import { isRetiredBrain, isRetiredRowKey } from "./retiredBrains";

describe("retired brains", () => {
  test("the old managed brain is retired; real agents are not", () => {
    expect(isRetiredBrain("aura_pro")).toBe(true);
    expect(isRetiredBrain("anthropic_native")).toBe(false);
    expect(isRetiredBrain("cli_wrapper:claude_code")).toBe(false);
    expect(isRetiredBrain("")).toBe(false);
    expect(isRetiredBrain(null)).toBe(false);
    expect(isRetiredBrain(undefined)).toBe(false);
  });

  test("a row key is judged by the brain before the `::`", () => {
    expect(isRetiredRowKey("aura_pro::claude-opus-5")).toBe(true);
    expect(isRetiredRowKey("anthropic_native::claude-opus-5")).toBe(false);
    expect(isRetiredRowKey("cli_wrapper:codex::gpt-5.5")).toBe(false);
    expect(isRetiredRowKey("aura_pro")).toBe(true);
  });
});
