import { describe, expect, test } from "bun:test";

import type { ChatTurn } from "../../../lib/api";
import { billingForBrain, summarizeSessionSpend } from "./spend";

// The session total is the one figure here that can quietly lie: every chat on
// disk predates per-turn prices, so "add up what we have" would under-report
// and look authoritative doing it. These pin the floor behaviour.

function turn(t: Partial<ChatTurn>): ChatTurn {
  return { role: "manager", text: "", at: 0, ...t };
}

describe("what this chat has cost", () => {
  test("priced turns add up", () => {
    const s = summarizeSessionSpend([
      turn({ cost_usd: 0.01 }),
      turn({ cost_usd: 0.02 }),
      { role: "user", text: "hi", at: 0 },
    ]);
    expect(s.sessionUsd).toBeCloseTo(0.03, 10);
    expect(s.sessionPartial).toBe(false);
    expect(s.sessionEstimated).toBe(false);
  });

  test("a chat with unpriced history reports a floor and says so", () => {
    const s = summarizeSessionSpend([
      turn({ cost_usd: 0.01 }),
      // History from before turns carried their price.
      turn({ input_tokens: 900, output_tokens: 40 }),
    ]);
    expect(s.sessionUsd).toBeCloseTo(0.01, 10);
    expect(s.sessionPartial).toBe(true);
  });

  test("a chat where nothing was priced shows no figure at all", () => {
    // Every turn ran on a CLI brain. Zero would read as "this was free".
    const s = summarizeSessionSpend([turn({}), turn({})]);
    expect(s.sessionUsd).toBeNull();
    expect(s.sessionPartial).toBe(false);
  });

  test("one estimated turn makes the whole total an estimate", () => {
    const s = summarizeSessionSpend([
      turn({ cost_usd: 0.01 }),
      turn({ cost_usd: 0.02, cost_estimated: true }),
    ]);
    expect(s.sessionEstimated).toBe(true);
  });

  test("a session that hasn't loaded yet is not a zero", () => {
    expect(summarizeSessionSpend(undefined).sessionUsd).toBeNull();
  });
});

describe("how a turn was paid for", () => {
  test("a CLI wrapper is a plan, and only a CLI wrapper", () => {
    expect(billingForBrain("cli_wrapper:claude_code")).toBe("subscription");
    expect(billingForBrain("cli:gemini")).toBe("subscription");
    expect(billingForBrain("gemini_native")).toBeNull();
    expect(billingForBrain("anthropic_native")).toBeNull();
    expect(billingForBrain(null)).toBeNull();
  });
});
