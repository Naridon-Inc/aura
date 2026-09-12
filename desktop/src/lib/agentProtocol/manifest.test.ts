import { describe, expect, test } from "bun:test";

import { AGENT_MANIFESTS, genericManifest, manifestFor, supportsStructuredChat } from "./manifest";
import { canNormalize, normalizeStream } from "./index";

// The manifest is a promise the renderer keeps: a flag turned on here is an
// affordance the chat will offer. Three entries had drifted into claiming
// questions, plans, permission gates and checklists their adapters never emit,
// which is a control with nothing on the other end of it. These tests hold the
// two halves together.

const WIRED = ["claude", "codex", "kimi", "opencode", "pi"];
const DECLARED_ONLY = ["gemini", "cursor"];

describe("every manifest matches the adapter behind it", () => {
  test("an agent with no adapter claims nothing", () => {
    for (const id of DECLARED_ONLY) {
      expect(normalizeStream(id, [], "s1")).toBeNull();
      const claimed = Object.entries(manifestFor(id).interactions)
        .filter(([, on]) => on)
        .map(([k]) => `${id}.${k}`);
      expect(claimed).toEqual([]);
    }
  });

  test("an agent with an adapter parses its own wire", () => {
    for (const id of WIRED) {
      expect(normalizeStream(id, [], "s1")).not.toBeNull();
    }
  });

  test("only agents with a wired adapter claim tool cards", () => {
    for (const [id, m] of Object.entries(AGENT_MANIFESTS)) {
      if (m.interactions.toolCalls) expect(WIRED).toContain(id);
    }
  });

  test("canNormalize means both halves are there", () => {
    for (const id of WIRED) expect(canNormalize(id)).toBe(true);
    for (const id of DECLARED_ONLY) expect(canNormalize(id)).toBe(false);
  });

  test("only Claude Code drives the interactive round-trips today", () => {
    // Questions, plans and permission gates are the three affordances that put
    // a control in front of the user. Anything added to this list must have an
    // adapter emitting that event — change the list in the SAME commit that
    // teaches the adapter, never before.
    const interactive = Object.entries(AGENT_MANIFESTS)
      .filter(
        ([, m]) =>
          m.interactions.questions || m.interactions.plan || m.interactions.permission,
      )
      .map(([id]) => id);
    expect(interactive).toEqual(["claude"]);
  });

  test("the checklist is claimed by exactly the engines that write one", () => {
    const todo = Object.entries(AGENT_MANIFESTS)
      .filter(([, m]) => m.interactions.todo)
      .map(([id]) => id)
      .sort();
    expect(todo).toEqual(["claude", "kimi", "opencode"]);
  });
});

describe("an agent we have never heard of", () => {
  test("resolves rather than throwing", () => {
    const m = manifestFor("some-toml-agent", "Some Agent");
    expect(m.label).toBe("Some Agent");
    expect(m.ingress).toBe("pty");
    expect(supportsStructuredChat("some-toml-agent")).toBe(false);
  });

  test("falls back to the raw view instead of an empty chat", () => {
    expect(normalizeStream("some-toml-agent", [], "s1")).toBeNull();
    expect(canNormalize("some-toml-agent")).toBe(false);
  });

  test("the generic manifest claims no interaction at all", () => {
    const on = Object.values(genericManifest("x").interactions).filter(Boolean);
    expect(on).toHaveLength(0);
  });
});
