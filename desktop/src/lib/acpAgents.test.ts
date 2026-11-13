import { describe, expect, test } from "bun:test";

import {
  groupAgents,
  installedByAura,
  methodLabel,
  resumeTab,
  sessionLine,
  sessionTitle,
  signInLine,
  sortAgents,
  staleVersion,
  standingLine,
  withRow,
  type AcpAgentRow,
} from "./acpAgents";

const agent = (more: Partial<AcpAgentRow> = {}): AcpAgentRow => ({
  id: "gemini",
  aura_id: "gemini",
  name: "Gemini CLI",
  version: "0.67.0",
  description: null,
  website: null,
  license: null,
  icon: null,
  state: "ready",
  source: { kind: "installed", version: "0.67.0" },
  program: "/Users/sam/.aura/acp/agents/gemini/0.67.0/node_modules/.bin/gemini",
  install_method: null,
  unverified: false,
  reason: null,
  signed_in_with: null,
  ...more,
});

describe("what Aura may change", () => {
  test("only a copy Aura installed is Aura's to update or remove", () => {
    expect(installedByAura(agent())).toBe(true);
    expect(installedByAura(agent({ source: { kind: "path" } }))).toBe(false);
    expect(installedByAura(agent({ source: { kind: "uvx" } }))).toBe(false);
    expect(installedByAura(agent({ state: "installable", source: null }))).toBe(false);
  });

  test("an update is due once the registry moves past Aura's copy", () => {
    expect(staleVersion(agent())).toBeNull();
    expect(staleVersion(agent({ source: { kind: "installed", version: "0.60.0" } }))).toBe("0.60.0");
    // A copy on PATH is the person's; Aura never offers to update it.
    expect(staleVersion(agent({ source: { kind: "path" } }))).toBeNull();
  });
});

describe("the list", () => {
  const rows = [
    agent({ id: "zed", name: "zed agent", state: "installable", source: null }),
    agent({ id: "amp", name: "Amp", state: "unavailable", source: null, reason: "Amp has no build for this machine" }),
    agent({ id: "qwen", name: "Qwen Code" }),
    agent({ id: "goose", name: "goose" }),
  ];

  test("ready agents lead, then names in any case", () => {
    expect(sortAgents(rows).map((r) => r.id)).toEqual(["goose", "qwen", "amp", "zed"]);
  });

  test("an install moves the agent to where its new standing puts it", () => {
    const installed = agent({ id: "zed", name: "zed agent" });
    const next = withRow(rows, installed);
    expect(next.map((r) => r.id)).toEqual(["goose", "qwen", "zed", "amp"]);
    expect(next.find((r) => r.id === "zed")?.state).toBe("ready");
    expect(withRow([], installed)).toEqual([installed]);
  });

  test("groups split on where each agent stands", () => {
    const g = groupAgents(sortAgents(rows));
    expect(g.here.map((r) => r.id)).toEqual(["goose", "qwen"]);
    expect(g.available.map((r) => r.id)).toEqual(["zed"]);
    expect(g.elsewhere.map((r) => r.id)).toEqual(["amp"]);
  });
});

describe("standingLine", () => {
  test("says where a ready agent runs from", () => {
    expect(standingLine(agent())).toBe("Version 0.67.0, installed by Aura.");
    expect(standingLine(agent({ source: { kind: "path" } }))).toBe("Aura uses the copy already on this computer.");
    expect(standingLine(agent({ source: { kind: "installed", version: "0.60.0" } }))).toBe(
      "Version 0.60.0 is installed. Version 0.67.0 is out.",
    );
  });

  test("warns before an install that can't be checked", () => {
    const base = { state: "installable" as const, source: null };
    expect(standingLine(agent({ ...base, install_method: "binary" }))).toContain("checks the download");
    expect(standingLine(agent({ ...base, install_method: "npm" }))).toContain("with npm into its own folder");
    expect(standingLine(agent({ ...base, install_method: "binary", unverified: true }))).toContain("no checksum");
  });

  test("an agent with no build here says why", () => {
    expect(standingLine(agent({ state: "unavailable", source: null, reason: "Amp has no build for this machine" }))).toBe(
      "Amp has no build for this machine",
    );
  });
});

describe("sign-in", () => {
  test("a remembered method reads as words", () => {
    expect(methodLabel("oauth-personal")).toBe("Oauth personal");
    expect(methodLabel("api_key")).toBe("Api key");
    expect(methodLabel("--")).toBe("--");
  });

  test("the card says whether the next chat signs in by itself", () => {
    expect(signInLine(agent({ signed_in_with: "oauth-personal" }))).toBe(
      "Signed in with Oauth personal. Aura signs in the same way next time.",
    );
    expect(signInLine(agent())).toContain("asks the first time you chat");
  });
});

describe("earlier chats", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const chat = { session_id: "s1", cwd: "/work/app", title: "  Fix the sum  ", updated_at: "2026-11-10T09:00:00Z" };

  test("a chat is named by its title, else plainly untitled", () => {
    expect(sessionTitle(chat)).toBe("Fix the sum");
    expect(sessionTitle({ ...chat, title: null })).toBe("Untitled chat");
    expect(sessionTitle({ ...chat, title: "   " })).toBe("Untitled chat");
  });

  test("a chat says when it last moved, else where it ran", () => {
    expect(sessionLine(chat, now)).toBe("Last active 3h ago");
    expect(sessionLine({ ...chat, updated_at: null }, now)).toBe("/work/app");
    expect(sessionLine({ ...chat, updated_at: "not a date" }, now)).toBe("/work/app");
  });

  test("resume opens a chat tab on the agent's Aura id that picks the chat up", () => {
    const tab = resumeTab(agent({ id: "qwen-code", aura_id: "qwen", name: "Qwen Code" }), chat, "/work/app", "chat-1");
    expect(tab).toEqual({
      sessionId: "chat-1",
      agentId: "qwen",
      agentLabel: "Qwen Code",
      agentMonogram: "Q",
      repoRoot: "/work/app",
      mode: "stream",
      resumeSessionId: "s1",
    });
  });
});
