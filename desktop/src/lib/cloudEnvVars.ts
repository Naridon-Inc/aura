// The member's own environment variables for cloud workspaces.
//
// The cloud keeps a name and a time for each; a value goes up once, on save,
// and never comes back. So a saved variable shows as its name and dots, and
// "Edit" means giving it a new value.

import { useCallback, useEffect, useState } from "react";

import { agentCredentialsApi, type SavedEnvVar } from "./cloudAgentCredentials";
import { cloudProblem } from "./cloudWorkspacesApi";
import { toast } from "./toast";

export type EnvEntry = { key: string; value: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variables an agent's sign-in sets. The cloud refuses them as plain
 *  variables, because the sign-in decides which one wins. Kept in step with
 *  the server's `agent_env_names`. */
export const AGENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "CURSOR_API_KEY",
]);

/** "A", "A and B", "A, B, and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  // An unquoted value ends at a comment.
  const hash = v.search(/\s#/);
  return hash >= 0 ? v.slice(0, hash).trimEnd() : v;
}

/** The KEY=VALUE lines of a pasted block or a .env file. Comments, blank
 *  lines and anything that is not a variable name are left out; a later line
 *  for the same name wins. */
export function parseEnvText(text: string): EnvEntry[] {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trimStart() : t;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!NAME.test(key)) continue;
    out.set(key, unquote(body.slice(eq + 1)));
  }
  return [...out].map(([key, value]) => ({ key, value }));
}

/** Text pasted into the key field that is really a block of variables. */
export function looksLikeEnvText(text: string): boolean {
  return /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(text) && parseEnvText(text).length > 0;
}

/** Why a variable can't be set here, or nothing. */
export function keyRefusal(key: string): string | undefined {
  if (key === "PATH")
    return "PATH is managed by the cloud computer. Change it in the computer's install script instead.";
  if (AGENT_KEYS.has(key)) return `${key} is set from the agent's sign-in, not here.`;
  return undefined;
}

/** What stops these variables being saved, in the order a person fixes it. */
export function entriesProblem(entries: EnvEntry[], existing: Set<string>): string | undefined {
  if (entries.length === 0 || entries.some((e) => e.key.trim() === "")) return "Key is required.";
  const bad = entries.map((e) => e.key.trim()).filter((k) => !NAME.test(k) || k.length > 128);
  if (bad.length > 0)
    return `Invalid variable ${bad.length === 1 ? "name" : "names"}: ${bad.join(", ")}. Names must start with a letter or underscore and contain only letters, numbers, and underscores.`;
  for (const e of entries) {
    const why = keyRefusal(e.key.trim());
    if (why) return why;
  }
  const taken = entries.map((e) => e.key.trim()).filter((k) => existing.has(k));
  if (taken.length > 0)
    return entries.length === 1
      ? `${taken[0]} already exists. Edit it instead.`
      : `These variables already exist: ${taken.join(", ")}. Edit them instead, or remove them from your pasted text.`;
  return undefined;
}

export type EnvVarsRead =
  | { status: "loading" }
  | { status: "ready"; vars: SavedEnvVar[] }
  /** The cloud server or this build has no env vars yet: said quietly. */
  | { status: "unavailable"; message: string }
  | { status: "failed"; message: string };

/** Read a failed list into what the panel says. */
export function envVarsRead(e: unknown): EnvVarsRead {
  const p = cloudProblem(e);
  if (p.kind === "unavailable")
    return { status: "unavailable", message: "Environment variables for cloud workspaces aren't available on your cloud server yet." };
  if (p.kind === "needs_update")
    return { status: "unavailable", message: "Update Aura to set environment variables for cloud workspaces." };
  if (p.kind === "signed_out")
    return { status: "unavailable", message: "Sign in to Aura's cloud to set environment variables for cloud workspaces." };
  return { status: "failed", message: p.message };
}

function failed() {
  toast.danger("Couldn't update your environment variables", "Check your connection and try again.");
}

const byName = (a: SavedEnvVar, b: SavedEnvVar) => a.name.localeCompare(b.name);

export function useCloudEnvVars() {
  const [read, setRead] = useState<EnvVarsRead>({ status: "loading" });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const vars = await agentCredentialsApi.envVars();
      setRead({ status: "ready", vars: [...(vars ?? [])].sort(byName) });
    } catch (e) {
      setRead(envVarsRead(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** Save each in turn; stop at the first the cloud refuses. */
  const save = useCallback(
    async (entries: EnvEntry[]): Promise<boolean> => {
      setSaving(true);
      try {
        for (const e of entries) await agentCredentialsApi.saveEnvVar(e.key.trim(), e.value);
        return true;
      } catch {
        failed();
        return false;
      } finally {
        setSaving(false);
        await reload();
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (name: string) => {
      try {
        await agentCredentialsApi.removeEnvVar(name);
      } catch {
        failed();
      }
      await reload();
    },
    [reload],
  );

  return { read, saving, save, remove, reload };
}
