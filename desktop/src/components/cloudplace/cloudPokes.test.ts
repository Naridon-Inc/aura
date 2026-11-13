import { describe, expect, test } from "bun:test";

import { serverSentence, type PokeDto } from "../../lib/cloudPokeApi";
import { FRESH_FOR_MS, freshPokes, pokeOutcome } from "./cloudPokes";
import { edgeDots } from "./PokeOverlay";

const NOW = Date.parse("2026-11-10T12:00:00Z");

function poke(id: string, agoMs: number): PokeDto {
  return {
    id,
    from_user_id: "u-ben",
    from_name: "Ben",
    created_at: new Date(NOW - agoMs).toISOString(),
  };
}

describe("pokes that reach you", () => {
  test("each is told once, and only while it is fresh", () => {
    const told = new Set(["p1"]);
    const rows = [poke("p1", 1_000), poke("p2", 2_000), poke("p3", FRESH_FOR_MS + 1), poke("p4", FRESH_FOR_MS)];
    expect(freshPokes(rows, told, NOW).map((p) => p.id)).toEqual(["p2", "p4"]);
  });

  test("a poke stamped a little ahead of this clock still counts", () => {
    expect(freshPokes([poke("p5", -3_000)], new Set(), NOW).map((p) => p.id)).toEqual(["p5"]);
  });

  test("a row without a readable time is dropped, not shown forever", () => {
    expect(freshPokes([{ ...poke("p6", 0), created_at: "soon" }], new Set(), NOW)).toEqual([]);
  });
});

describe("what the sender is told", () => {
  test("delivered, or held back by the other side's setting", () => {
    expect(pokeOutcome("Ana", { delivered: true })).toEqual({ tone: "success", title: "Poked Ana" });
    expect(pokeOutcome("Ana", { delivered: false })).toEqual({ tone: "info", title: "Ana didn't get the poke" });
  });

  test("a refusal says the server's reason", () => {
    const e = 'HTTP 429 Too Many Requests: {"error":"You just poked them. Give it a moment.","retry_after_secs":20}';
    expect(pokeOutcome("Ana", { error: e }).title).toBe("You just poked them. Give it a moment.");
    expect(pokeOutcome("Ana", { error: new Error("HTTP 403 Forbidden: {\"error\":\"Turn on pokes in Settings to poke teammates.\"}") }).title).toBe(
      "Turn on pokes in Settings to poke teammates.",
    );
  });

  test("anything else falls back to trying again", () => {
    expect(pokeOutcome("Ana", { error: "HTTP 500: oops" }).title).toBe("Couldn't poke Ana. Try again.");
    expect(pokeOutcome("Ana", { error: "network down" }).title).toBe("Couldn't poke Ana. Try again.");
    expect(serverSentence('HTTP 403: {"error":"upgrade_required"}')).toBeNull();
  });
});

describe("the overlay", () => {
  test("puts dots on all four edges, each heading inward", () => {
    const dots = edgeDots(4);
    expect(dots.length).toBe(16);
    const top = dots.slice(0, 4).map((d) => d.style as Record<string, string | number>);
    for (const s of top) {
      expect(s.top).toBe(-6);
      expect(s["--poke-dx"]).toBe("0px");
      expect(parseInt(String(s["--poke-dy"]), 10)).toBeGreaterThan(0);
    }
    const right = dots[4]!.style as Record<string, string | number>;
    expect(parseInt(String(right["--poke-dx"]), 10)).toBeLessThan(0);
  });
});
