// Each member's own agent sign-ins for cloud workspaces.
//
// The cloud computer is the organization's; the Claude, Codex or Cursor
// account an agent runs on is the member's. A value goes up once, on save.
// The cloud answers with names only, so nothing here can show a saved value
// again — "connected" is the most this side ever knows.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { cloudProblem } from "./cloudWorkspacesApi";

export type Harness = "claude" | "codex" | "cursor";

export type CredentialName =
  | "anthropic_api_key"
  | "claude_code_oauth_token"
  | "codex_api_key"
  | "codex_chatgpt_auth"
  | "cursor_api_key"
  | "openrouter_api_key"
  | "vercel_ai_gateway_api_key"
  | "bedrock_credentials"
  | "claude_user_managed"
  | "codex_user_managed";

export type SavedCredential = {
  name: string;
  workspace_id: string | null;
  updated_at: string;
  /** The key's last four characters, when the server keeps a safe one; for a
   *  ChatGPT plan, the account it signed in as. Older servers and older rows
   *  have none. */
  hint?: string | null;
};
export type SavedSelection = { harness: string; selection: "subscription" | "api_key" };
export type SavedEnvVar = { name: string; updated_at: string };

/** How each agent signs in, in the order the dialog lists it. */
export type HarnessSpec = {
  id: Harness;
  label: string;
  /** The brand id `AgentIcon` draws. */
  provider: string;
  subscription: CredentialName | null;
  /** What the subscription is called on its Connect button. */
  plan: string | null;
  apiKey: CredentialName;
  createKeyUrl: string;
  /** The variable the key lands in, shown as the field's placeholder. */
  apiKeyPlaceholder: string;
};

export const HARNESSES: HarnessSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    provider: "anthropic",
    subscription: "claude_code_oauth_token",
    plan: "Claude subscription",
    apiKey: "anthropic_api_key",
    createKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "ANTHROPIC_API_KEY",
  },
  {
    id: "codex",
    label: "Codex",
    provider: "openai",
    subscription: "codex_chatgpt_auth",
    plan: "ChatGPT plan",
    apiKey: "codex_api_key",
    createKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "OPENAI_API_KEY",
  },
  {
    id: "cursor",
    label: "Cursor",
    provider: "cursor",
    subscription: null,
    plan: null,
    apiKey: "cursor_api_key",
    createKeyUrl: "https://cursor.com/dashboard/api?section=user-keys#user-api-keys",
    apiKeyPlaceholder: "CURSOR_API_KEY",
  },
];

export function harnessSpec(id: string): HarnessSpec | undefined {
  return HARNESSES.find((h) => h.id === id);
}

/** A provider that stands in for the agent's own sign-in. */
export type CustomProvider = {
  name: CredentialName;
  label: string;
  harnesses: Harness[];
  placeholder: string;
  createKeyUrl?: string;
};

export const CUSTOM_PROVIDERS: CustomProvider[] = [
  {
    name: "vercel_ai_gateway_api_key",
    label: "Vercel AI Gateway",
    harnesses: ["claude", "codex"],
    placeholder: "AI_GATEWAY_API_KEY",
  },
  {
    name: "openrouter_api_key",
    label: "OpenRouter",
    harnesses: ["codex"],
    placeholder: "OPENROUTER_API_KEY",
    createKeyUrl: "https://openrouter.ai/settings/keys",
  },
  {
    name: "bedrock_credentials",
    label: "Amazon Bedrock",
    harnesses: ["claude"],
    placeholder: "AWS_BEARER_TOKEN_BEDROCK",
  },
];

/** Manual setup: the member keeps the agent's sign-in on the machine. */
export const MANUAL: Partial<Record<Harness, { name: CredentialName; file: string }>> = {
  claude: { name: "claude_user_managed", file: "~/.claude/.credentials.json" },
  codex: { name: "codex_user_managed", file: "~/.codex/auth.json" },
};

/** What each saved sign-in is called on screen. */
export function credentialLabel(name: string): string {
  switch (name) {
    case "anthropic_api_key":
      return "Claude Code API key";
    case "claude_code_oauth_token":
      return "Claude Code subscription";
    case "codex_api_key":
      return "Codex API key";
    case "codex_chatgpt_auth":
      return "ChatGPT plan";
    case "cursor_api_key":
      return "Cursor API key";
    case "openrouter_api_key":
      return "OpenRouter key";
    case "vercel_ai_gateway_api_key":
      return "Vercel AI Gateway key";
    case "bedrock_credentials":
      return "Amazon Bedrock";
    case "claude_user_managed":
    case "codex_user_managed":
      return "Manual";
    default:
      return name;
  }
}

/** Sign-ins whose hint is the account they signed in as, not a key's tail. */
const ACCOUNT_HINTS = new Set<string>(["codex_chatgpt_auth"]);

/** The account a saved sign-in signed in as, when it is one that says. */
export function accountHint(saved: SavedCredential | undefined): string | null {
  return saved?.hint && ACCOUNT_HINTS.has(saved.name) ? saved.hint : null;
}

/** How a saved sign-in shows: the account it signed in as, its last four
 *  characters behind dots, or just "Saved" when the server keeps no hint. */
export function maskedHint(saved: SavedCredential | undefined): string {
  if (!saved?.hint) return "Saved";
  return accountHint(saved) ?? `••••${saved.hint}`;
}

/** The agents a member's saved sign-ins let cloud workspaces run. Only the
 *  member's defaults count; a one-workspace override doesn't connect an
 *  agent everywhere. */
export function connectedHarnesses(saved: SavedCredential[]): Set<Harness> {
  const names = new Set(saved.filter((c) => !c.workspace_id).map((c) => c.name));
  const out = new Set<Harness>();
  for (const h of HARNESSES) {
    if (names.has(h.apiKey) || (h.subscription && names.has(h.subscription))) out.add(h.id);
    if (MANUAL[h.id] && names.has(MANUAL[h.id]!.name)) out.add(h.id);
  }
  for (const p of CUSTOM_PROVIDERS) if (names.has(p.name)) p.harnesses.forEach((h) => out.add(h));
  return out;
}

/** The Bedrock value the cloud reads. */
export function bedrockValue(
  b:
    | { kind: "bearer"; bearerToken: string; region: string; testModel?: string }
    | {
        kind: "access_keys";
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
        region: string;
        testModel?: string;
      },
): string {
  const auth =
    b.kind === "bearer"
      ? { type: "bearer", bearerToken: b.bearerToken.trim() }
      : {
          type: "access_keys",
          accessKeyId: b.accessKeyId.trim(),
          secretAccessKey: b.secretAccessKey.trim(),
          ...(b.sessionToken?.trim() ? { sessionToken: b.sessionToken.trim() } : {}),
        };
  return JSON.stringify({
    version: 1,
    auth,
    region: b.region.trim(),
    ...(b.testModel?.trim() ? { testModel: b.testModel.trim() } : {}),
  });
}

export const agentCredentialsApi = {
  list: () =>
    invoke<{ credentials: SavedCredential[]; selections: SavedSelection[] }>("cloud_agent_credentials_list"),
  save: (name: CredentialName, value: string, workspaceId?: string | null) =>
    invoke<SavedCredential>("cloud_agent_credential_save", { name, value, workspaceId: workspaceId ?? null }),
  remove: (name: CredentialName, workspaceId?: string | null) =>
    invoke<unknown>("cloud_agent_credential_remove", { name, workspaceId: workspaceId ?? null }),
  select: (harness: Harness, selection: "subscription" | "api_key") =>
    invoke<unknown>("cloud_agent_selection_set", { harnessName: harness, selection }),
  envVars: () => invoke<SavedEnvVar[]>("cloud_env_vars_list"),
  saveEnvVar: (name: string, value: string) => invoke<SavedEnvVar>("cloud_env_var_save", { name, value }),
  removeEnvVar: (name: string) => invoke<unknown>("cloud_env_var_remove", { name }),
};

// One shared read, so the setup page, the create dialog and a workspace's
// composer agree on what is connected the moment a save lands.

type Snapshot = {
  loaded: boolean;
  credentials: SavedCredential[];
  selections: SavedSelection[];
  error: string | null;
};

let snapshot: Snapshot = { loaded: false, credentials: [], selections: [], error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function reloadAgentCredentials(): Promise<void> {
  inflight ??= agentCredentialsApi
    .list()
    .then((r) =>
      publish({ loaded: true, credentials: r.credentials ?? [], selections: r.selections ?? [], error: null }),
    )
    .catch((e) => publish({ ...snapshot, loaded: true, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The quiet line shown in place of the agents when this app is ahead of
 *  its cloud server (or behind it): nothing to fix, so no error. Null when
 *  the read worked or failed for a reason worth surfacing. */
export function agentsUnavailable(error: string | null): string | null {
  if (!error) return null;
  const { kind } = cloudProblem(error);
  if (kind === "unavailable") return "Connecting agents for cloud workspaces isn\u2019t available on your cloud server yet.";
  if (kind === "needs_update") return "Update Aura to connect agents for cloud workspaces.";
  return null;
}

export function useAgentCredentials(): Snapshot {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  useEffect(() => {
    if (!snapshot.loaded) void reloadAgentCredentials();
  }, []);
  return snap;
}
