import { describe, expect, test } from "bun:test";

import {
  buildTurnCost,
  hasTurnCost,
  turnCostRange,
  turnCostTitle,
} from "./turnCost";

// The card's whole claim is that it reports, never estimates. These pin the
// two ways that claim breaks: a zero drawn where we simply weren't told, and
// a name repeated because the engine and the model share a word.

describe("who ran the turn", () => {
  test("model and agent read as one line", () => {
    expect(turnCostTitle("Opus 5", "Claude Code")).toBe("Opus 5 via Claude Code");
  });

  test("an engine that names itself as the model is said once", () => {
    expect(turnCostTitle("Codex", "codex")).toBe("Codex");
  });

  test("half an answer is still an answer", () => {
    expect(turnCostTitle("Opus 5", null)).toBe("Opus 5");
    expect(turnCostTitle("  ", "Gemini CLI")).toBe("Gemini CLI");
    expect(turnCostTitle(null, undefined)).toBeNull();
  });
});

describe("the window it occupied", () => {
  test("both ends give a range", () => {
    const r = turnCostRange(1_785_600_000_000, 1_785_612_000_000);
    expect(r).toContain("→");
  });

  test("a turn that finished inside the minute reads as one moment", () => {
    // The common case. At minute resolution both halves format identically,
    // and the card was printing the same timestamp twice with an arrow
    // between them, wrapped over two lines.
    const r = turnCostRange(1_785_600_000_000, 1_785_600_000_900);
    expect(r).not.toContain("→");
  });

  test("a range inside one day says the date once", () => {
    const r = turnCostRange(1_785_600_000_000, 1_785_612_000_000);
    expect(r).toContain("→");
    // "Jul 25, 2026 at 8:41 PM → 11:41 PM", not the date on both sides.
    expect(r!.split("→")[1]).not.toMatch(/\d{4}/);
  });

  test("one end narrows the answer rather than withholding it", () => {
    expect(turnCostRange(null, 1_785_612_000_000)).not.toBeNull();
    expect(turnCostRange(1_785_600_000_000, null)).not.toBeNull();
  });

  test("no clock, no claim", () => {
    expect(turnCostRange(null, null)).toBeNull();
    expect(turnCostRange(0, 0)).toBeNull();
  });
});

describe("the tokens it moved", () => {
  test("a figure we weren't told is not a row", () => {
    const cost = buildTurnCost({
      inputTokens: 219_169,
      outputTokens: 1_676,
      // No cache planes reported by this engine.
    });
    expect(cost.rows.map((r) => r.label)).toEqual(["Input", "Output"]);
  });

  test("cache planes appear when the engine reports them", () => {
    const cost = buildTurnCost({
      inputTokens: 12,
      outputTokens: 3,
      cacheRead: 216_832,
      cacheWrite: 4_096,
    });
    expect(cost.rows.map((r) => r.label)).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ]);
    expect(cost.rows[2]?.value).toBe(216_832);
  });

  test("a turn nobody measured has no card to show", () => {
    expect(hasTurnCost(buildTurnCost({}))).toBe(false);
    expect(hasTurnCost(buildTurnCost({ model: "Opus 5" }))).toBe(true);
  });
});

// The money block is the part that can do real damage: a fabricated zero on a
// turn somebody paid for reads as authoritative and is simply false. These pin
// each way we might be tempted to print one.

describe("what it cost", () => {
  test("money leads, in the order people ask for it", () => {
    const cost = buildTurnCost({
      model: "gemini-2.5-pro",
      inputTokens: 19_742,
      outputTokens: 32,
      costUsd: 0.0247,
      sessionCostUsd: 0.18,
      totalCostUsd: 4.12,
    });
    expect(cost.money.map((m) => m.label)).toEqual([
      "This message",
      "This chat",
      "All time",
    ]);
    expect(cost.money[0]?.lead).toBe(true);
    expect(cost.unpriced).toBeNull();
    // Tokens survive as the working behind the figure.
    expect(cost.rows.map((r) => r.label)).toEqual(["Input", "Output"]);
  });

  test("a model with no rate says so instead of showing $0.00", () => {
    const cost = buildTurnCost({
      model: "some-local-llama",
      inputTokens: 19_742,
      outputTokens: 32,
    });
    expect(cost.money.some((m) => m.label === "This message")).toBe(false);
    expect(cost.unpriced).toContain("some-local-llama");
  });

  test("no counts, no cost, and it says which", () => {
    const cost = buildTurnCost({ model: "gemini-2.5-pro" });
    expect(cost.money).toEqual([]);
    expect(cost.unpriced).toBe(
      "The engine reported no token counts for this message.",
    );
  });

  test("a subscription turn is blank on purpose and says why", () => {
    const cost = buildTurnCost({
      agent: "Claude Code",
      inputTokens: 900,
      outputTokens: 40,
      billing: "subscription",
    });
    expect(cost.money).toEqual([]);
    expect(cost.unpriced).toContain("your plan");
  });

  test("an engine's run total is never passed off as this message's price", () => {
    const cost = buildTurnCost({
      agent: "Claude Code",
      inputTokens: 900,
      outputTokens: 40,
      sessionCostUsd: 0.42,
      sessionIsRunTotal: true,
    });
    expect(cost.money.map((m) => m.label)).toEqual(["This run"]);
    expect(cost.unpriced).toBe("This engine bills the run, not each message.");
  });

  test("a chat with unpriced history is a floor, not a total", () => {
    const cost = buildTurnCost({
      costUsd: 0.01,
      sessionCostUsd: 0.05,
      sessionPartial: true,
    });
    expect(cost.money.find((m) => m.label === "This chat")?.atLeast).toBe(true);
  });

  test("a key that has spent nothing really has spent nothing", () => {
    // Zero is a reading; null is an absence. Only the second is withheld.
    const cost = buildTurnCost({ costUsd: 0, totalCostUsd: 0 });
    expect(cost.money.map((m) => m.usd)).toEqual([0, 0]);
    const nothing = buildTurnCost({ costUsd: null, totalCostUsd: undefined });
    expect(nothing.money).toEqual([]);
  });
});
