// Sign-in for the two agents whose CLIs expose it: Claude Code and Codex.
// Each CLI owns its own account; Aura only asks it for its status and starts
// its login command, which opens the browser and returns once it is done.
//
// Asking for the status spawns the CLI (100–200 ms each, more on a cold
// disk), and Settings → Agents used to ask on every open. The answer now
// lives in the shared cache: a reopen shows the last status at once, and a
// status younger than STATUS_FRESH_MS is not asked again. Every sign-in,
// sign-out and "Check again" re-reads it for real. It stays in memory only:
// it names the signed-in account, which has no business in localStorage.

import { useCallback, useState } from "react";

import { api } from "../../../lib/api";
import { useCachedResource } from "../../../lib/useCachedResource";
import type { ClaudeStatus, CodexStatus } from "./agentModel";

export type AuthAction = "status" | "login" | "logout" | "key" | null;

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long a sign-in status is shown without asking the CLI again. */
const STATUS_FRESH_MS = 30_000;

const readClaude = () => api.claudeAuthStatus();
const readCodex = () => api.codexAuthStatus();

export interface ClaudeAuth {
  status: ClaudeStatus | null;
  cliMissing: boolean;
  action: AuthAction;
  error: string | null;
  refresh: () => Promise<void>;
  login: (method: "claudeai" | "console") => Promise<void>;
  logout: () => Promise<void>;
}

export interface CodexAuth {
  status: CodexStatus | null;
  action: AuthAction;
  error: string | null;
  refresh: () => Promise<void>;
  login: () => Promise<void>;
  saveApiKey: (key: string) => Promise<boolean>;
}

export function useClaudeAuth(enabled: boolean): ClaudeAuth {
  const read = useCachedResource<ClaudeStatus>("agent-auth:claude", readClaude, {
    enabled,
    freshMs: STATUS_FRESH_MS,
  });
  const [action, setAction] = useState<AuthAction>(null);
  const [error, setError] = useState<string | null>(null);
  // No CLI is not an error to show: the panel offers to install it instead,
  // and whatever status was cached before belongs to a CLI that is gone.
  const cliMissing = read.staleError?.includes("not on PATH") ?? false;
  const status = cliMissing ? null : (read.data ?? null);
  const reload = read.reload;

  const run = useCallback(
    async (next: AuthAction, work: () => Promise<unknown>) => {
      setAction(next);
      setError(null);
      try {
        await work();
      } catch (e) {
        setError(reason(e));
      }
      await reload();
      setAction(null);
    },
    [reload],
  );

  return {
    status,
    cliMissing,
    action,
    error: error ?? (cliMissing ? null : read.staleError),
    refresh: () => run("status", async () => undefined),
    // `claude auth login` reports a cancelled or failed browser flow only
    // through its exit code.
    login: (method) =>
      run("login", async () => {
        const code = await api.claudeAuthLogin(method);
        if (code !== 0) throw new Error(`Claude Code's sign-in ended without finishing (exit ${code}).`);
      }),
    logout: () => run("logout", () => api.claudeAuthLogout()),
  };
}

export function useCodexAuth(enabled: boolean): CodexAuth {
  const read = useCachedResource<CodexStatus>("agent-auth:codex", readCodex, {
    enabled,
    freshMs: STATUS_FRESH_MS,
  });
  const [action, setAction] = useState<AuthAction>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = read.reload;

  const run = useCallback(
    async (next: AuthAction, work: () => Promise<unknown>): Promise<boolean> => {
      setAction(next);
      setError(null);
      let ok = true;
      try {
        await work();
      } catch (e) {
        setError(reason(e));
        ok = false;
      }
      await reload();
      setAction(null);
      return ok;
    },
    [reload],
  );

  return {
    status: read.data ?? null,
    action,
    error: error ?? read.staleError,
    refresh: async () => {
      await run("status", async () => undefined);
    },
    login: async () => {
      await run("login", () => api.codexAuthLogin());
    },
    saveApiKey: (key) => run("key", () => api.codexAuthLoginApiKey(key)),
  };
}
