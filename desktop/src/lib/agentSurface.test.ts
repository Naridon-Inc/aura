import { describe, expect, test } from "bun:test";

import type { AgentMode } from "./api";
import { hostsLiveAgent, liveAgentLabel } from "./agentSurface";
import { agentModeFor } from "../components/manager/ManagerComposer";

// The mode chip is the piece worth pinning. It used to be a sentence
// prepended to the prompt; on an agent that has real modes it now switches
// the agent itself, and OpenCode's plan mode refuses every edit tool. So
// the only failure that matters is the narrowing sending a read-only
// position to a mode that writes.

const OPENCODE: AgentMode[] = [
  { id: "build", name: "Build", description: "Make the changes" },
  { id: "plan", name: "Plan", description: "Discuss, do not edit" },
];

describe("which of the agent's modes an Aura mode means", () => {
  test("everything that promises not to edit asks for plan", () => {
    expect(agentModeFor("plan", OPENCODE)).toBe("plan");
    expect(agentModeFor("ask", OPENCODE)).toBe("plan");
  });

  test("everything that expects work done takes the other one", () => {
    expect(agentModeFor("build", OPENCODE)).toBe("build");
    expect(agentModeFor("auto", OPENCODE)).toBe("build");
  });

  test("an agent whose plan mode is named something else is still found", () => {
    const modes: AgentMode[] = [
      { id: "default", name: "Default", description: "" },
      { id: "planning", name: "Planning only", description: "" },
    ];
    expect(agentModeFor("ask", modes)).toBe("planning");
    expect(agentModeFor("build", modes)).toBe("default");
  });

  test("an agent with no read-only mode is told nothing rather than told to build", () => {
    // Returning `build` here would be the dangerous answer: the chip would
    // say Plan, the agent would edit, and nothing would have gone wrong
    // loudly enough to notice.
    const modes: AgentMode[] = [{ id: "build", name: "Build", description: "" }];
    expect(agentModeFor("plan", modes)).toBeNull();
  });

  test("no modes at all means the chip stays the prompt steer it was", () => {
    expect(agentModeFor("plan", [])).toBeNull();
    expect(agentModeFor("build", [])).toBeNull();
  });
});

describe("which brains host an agent", () => {
  test("the two that own a process do", () => {
    expect(hostsLiveAgent("pi")).toBe(true);
    expect(hostsLiveAgent("acp:opencode")).toBe(true);
  });

  test("brains that are an API key and a model id do not", () => {
    expect(hostsLiveAgent("anthropic_native")).toBe(false);
    expect(hostsLiveAgent("openai_compat:kimi")).toBe(false);
    expect(hostsLiveAgent("cli_wrapper:gemini")).toBe(false);
    expect(hostsLiveAgent(null)).toBe(false);
  });
});

describe("badging an agent's own commands", () => {
  test("known agents get their own spelling", () => {
    expect(liveAgentLabel("acp:opencode")).toBe("OpenCode");
    expect(liveAgentLabel("pi")).toBe("Pi");
  });

  test("an agent added to the Rust table first still badges readably", () => {
    expect(liveAgentLabel("acp:aardvark")).toBe("Aardvark");
  });

  test("a brain with no agent behind it has no badge", () => {
    expect(liveAgentLabel("anthropic_native")).toBeNull();
  });
});
