import { describe, expect, test } from "bun:test";

import { buildSteeringText, type SteeringMode } from "./managerSteering";
import {
  buildGoalDirective,
  hasGoalDirective,
  stripSteeringDirective,
} from "./steeringDirective";

// The steering prefixes are model-facing wiring. They have to reach the brain
// and must never reach the screen, so the stripper is pinned against the
// directives the composer *actually* sends — not against a re-typed sample.
// The bug these guard: the pattern required a dash after the marker while
// `buildSteeringText` writes a full stop, so a user on Auto saw the entire
// autopilot instruction quoted back inside their own chat bubble.

const STEERED_MODES: SteeringMode[] = ["auto", "plan", "ask"];

describe("the composer's steering prefix", () => {
  test("is stripped for every mode that carries one", () => {
    for (const mode of STEERED_MODES) {
      const prefix = buildSteeringText(mode);
      expect(prefix).not.toBe("");
      expect(stripSteeringDirective(`${prefix}how intelligent are you?`)).toBe(
        "how intelligent are you?",
      );
    }
  });

  test("build sends nothing, so there is nothing to strip", () => {
    expect(buildSteeringText("build")).toBe("");
    expect(stripSteeringDirective("ship it")).toBe("ship it");
  });

  test("the goal block is stripped and still badges the turn", () => {
    const raw = `${buildGoalDirective()}rewrite the importer`;
    expect(hasGoalDirective(raw)).toBe(true);
    expect(stripSteeringDirective(raw)).toBe("rewrite the importer");
  });

  test("a stacked pipe + mode + goal prefix all come off", () => {
    // The PTY pipe marker as `ManagerChatView.send` writes it; the three can
    // arrive together on one turn.
    const piped =
      "[↪ PIPED. User also wrote this message directly into an open agent PTY tab. " +
      "Do NOT dispatch a new agent for the same ask; respond conversationally and " +
      "only act if explicitly asked.]\n\n";
    const raw = `${piped}${buildSteeringText("auto")}${buildGoalDirective()}Ship it`;
    expect(stripSteeringDirective(raw)).toBe("Ship it");
  });
});

describe("what the stripper must leave alone", () => {
  test("a message that merely opens with a bracket survives", () => {
    expect(stripSteeringDirective("[urgent] please refactor the parser")).toBe(
      "[urgent] please refactor the parser",
    );
  });

  test("a near-miss marker is not a directive", () => {
    // `MODE\b` is what keeps this out — a turn about picking a model must not
    // lose its first line.
    const raw = "[AUTO MODEL. which one is cheapest?]\n\nand why";
    expect(stripSteeringDirective(raw)).toBe(raw);
  });

  test("a directive in the middle of a turn is not a prefix", () => {
    const raw = "explain this: [AUTO MODE. Full autopilot.]";
    expect(stripSteeringDirective(raw)).toBe(raw);
  });

  test("the user's own text is returned verbatim, whitespace and all", () => {
    const raw = `${buildSteeringText("plan")}line one\n\n  line two  `;
    expect(stripSteeringDirective(raw)).toBe("line one\n\n  line two  ");
  });
});
