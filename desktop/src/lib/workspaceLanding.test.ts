import { describe, expect, it } from "bun:test";

import { resolveWorkspaceLanding } from "./workspaceLanding";

const INSTALLED = ["claude", "codex", "gemini"];

describe("resolveWorkspaceLanding", () => {
  it("defaults to the code — a new copy opens nothing on its own", () => {
    expect(resolveWorkspaceLanding("code", INSTALLED)).toEqual({ kind: "code" });
  });

  it("treats an unset setting as the default rather than an error", () => {
    expect(resolveWorkspaceLanding(null, INSTALLED)).toEqual({ kind: "code" });
    expect(resolveWorkspaceLanding(undefined, INSTALLED)).toEqual({ kind: "code" });
    expect(resolveWorkspaceLanding("", INSTALLED)).toEqual({ kind: "code" });
    expect(resolveWorkspaceLanding("   ", INSTALLED)).toEqual({ kind: "code" });
  });

  it("keeps the old behaviour reachable", () => {
    expect(resolveWorkspaceLanding("chat", INSTALLED)).toEqual({ kind: "chat" });
  });

  it("opens an installed agent CLI by id", () => {
    expect(resolveWorkspaceLanding("codex", INSTALLED)).toEqual({
      kind: "agent",
      agentId: "codex",
    });
  });

  it("degrades an uninstalled agent to the code, not a failure", () => {
    // Someone uninstalls Codex. Their copies must keep opening.
    expect(resolveWorkspaceLanding("codex", ["claude"])).toEqual({ kind: "code" });
  });

  it("degrades a value this build has never heard of", () => {
    // A settings.toml written by a newer build, read by an older one.
    expect(resolveWorkspaceLanding("some-future-mode", INSTALLED)).toEqual({
      kind: "code",
    });
  });

  it("does not resolve chat through the agent path even if an agent is named chat", () => {
    expect(resolveWorkspaceLanding("chat", ["chat"])).toEqual({ kind: "chat" });
  });
});
