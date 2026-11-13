import { describe, expect, test } from "bun:test";

import {
  accountHint,
  agentsUnavailable,
  bedrockValue,
  connectedHarnesses,
  credentialLabel,
  maskedHint,
  type SavedCredential,
} from "./cloudAgentCredentials";

const saved = (name: string, workspace_id: string | null = null): SavedCredential =>
  ({ name, workspace_id, updated_at: "2026-11-09T00:00:00Z" }) as SavedCredential;

describe("connectedHarnesses", () => {
  test("nothing saved connects nothing", () => {
    expect([...connectedHarnesses([])]).toEqual([]);
  });

  test("a subscription or a key connects its own agent", () => {
    expect([...connectedHarnesses([saved("claude_code_oauth_token")])]).toEqual(["claude"]);
    expect([...connectedHarnesses([saved("codex_api_key")])]).toEqual(["codex"]);
    expect([...connectedHarnesses([saved("codex_chatgpt_auth")])]).toEqual(["codex"]);
  });

  test("a shared provider connects every agent it serves", () => {
    expect([...connectedHarnesses([saved("vercel_ai_gateway_api_key")])].sort()).toEqual(["claude", "codex"]);
  });

  test("a one-workspace override doesn't connect the agent everywhere", () => {
    expect([...connectedHarnesses([saved("anthropic_api_key", "ws-1")])]).toEqual([]);
  });
});

describe("credentialLabel", () => {
  test("names a sign-in by what it is", () => {
    expect(credentialLabel("anthropic_api_key")).toBe("Claude Code API key");
    expect(credentialLabel("claude_code_oauth_token")).toBe("Claude Code subscription");
    expect(credentialLabel("codex_chatgpt_auth")).toBe("ChatGPT plan");
  });
});

describe("bedrockValue", () => {
  test("a Bedrock API key with its region, trimmed", () => {
    expect(JSON.parse(bedrockValue({ kind: "bearer", bearerToken: " fake ", region: " us-east-1 " }))).toEqual({
      version: 1,
      auth: { type: "bearer", bearerToken: "fake" },
      region: "us-east-1",
    });
  });

  test("access keys leave out an empty session token", () => {
    const v = JSON.parse(
      bedrockValue({ kind: "access_keys", accessKeyId: "FAKEID", secretAccessKey: "fake", sessionToken: " ", region: "eu-west-1" }),
    );
    expect(v.auth).toEqual({ type: "access_keys", accessKeyId: "FAKEID", secretAccessKey: "fake" });
  });
});

describe("maskedHint", () => {
  test("a saved key shows its last four behind dots, anything else just Saved", () => {
    expect(maskedHint({ ...saved("anthropic_api_key"), hint: "wxyz" })).toBe("••••wxyz");
    expect(maskedHint(saved("anthropic_api_key"))).toBe("Saved");
    expect(maskedHint({ ...saved("bedrock_credentials"), hint: null })).toBe("Saved");
    expect(maskedHint(undefined)).toBe("Saved");
  });

  test("a ChatGPT plan shows the account it signed in as, not dots", () => {
    expect(maskedHint({ ...saved("codex_chatgpt_auth"), hint: "sam@example.com · Plus" })).toBe("sam@example.com · Plus");
    expect(maskedHint(saved("codex_chatgpt_auth"))).toBe("Saved");
  });

  test("only a sign-in that names its account has one", () => {
    expect(accountHint({ ...saved("codex_chatgpt_auth"), hint: "sam@example.com · Plus" })).toBe("sam@example.com · Plus");
    expect(accountHint({ ...saved("anthropic_api_key"), hint: "wxyz" })).toBeNull();
    expect(accountHint(undefined)).toBeNull();
  });
});

describe("agentsUnavailable", () => {
  test("a server without the agent sign-in API reads as not available yet", () => {
    expect(agentsUnavailable("HTTP 404 Not Found: ")).toContain("isn\u2019t available on your cloud server yet");
    expect(agentsUnavailable("command cloud_agent_credentials_list not found")).toBe(
      "Update Aura to connect agents for cloud workspaces.",
    );
  });

  test("no error, or one worth showing, gets no quiet line", () => {
    expect(agentsUnavailable(null)).toBeNull();
    expect(agentsUnavailable("HTTP 500: boom")).toBeNull();
    expect(agentsUnavailable("HTTP 401: signed out")).toBeNull();
  });
});
