// Live agent registry. Backed by `agent_discover` which scans PATH for
// claude / gemini / codex / cursor-agent and runs `--version` to confirm
// each is callable. The list is reality — if the user doesn't have an
// agent installed, it doesn't show up. Pickers should render an
// "install one of …" empty state when discovery returns nothing
// available.

import { useEffect, useState } from "react";
import { api, type AgentInfo } from "./api";
import { AURA_MANAGER_ENABLED } from "./featureFlags";

export type Agent = {
  id: string;
  label: string;
  description: string;
  monogram?: string;
  /** True if the binary is in PATH and answered `--version`. */
  available: boolean;
  /** True if we can pass `-c` / `--continue` for follow-up messages. */
  continuable: boolean;
};

// Synthetic Manager peer. Not a binary on PATH — handled in-process by
// the Tauri shell's manager runtime. Sits at the head of the picker so
// users reach for the coordinator first when an objective spans
// multiple skills (frontend+backend, refactor+tests, ...).
export const MANAGER_AGENT: Agent = {
  id: "aura-manager",
  label: "Aura",
  monogram: "M",
  description: "Coordinator. Fans out to subagents, chains their outputs",
  available: true,
  continuable: true,
};

// Module-level cache so multiple components don't all probe PATH at
// mount. Discovery is idempotent and cheap, but a few hundred ms hit
// per consumer would still feel sluggish.
let cache: Agent[] | null = null;
let pending: Promise<Agent[]> | null = null;

export function useAgents(): { agents: Agent[]; loading: boolean; refresh: () => void } {
  const [agents, setAgents] = useState<Agent[]>(cache ?? []);
  const [loading, setLoading] = useState<boolean>(cache === null);

  function load() {
    setLoading(true);
    if (!pending) {
      pending = api
        .agentDiscover()
        .then((raw) =>
          // Manager rides at the head of the picker, but only when the
          // native orchestrator is enabled; with the flag off we ship the
          // discovered CLI agents alone so the "Aura" tile leaves every
          // launcher and picker in lockstep.
          AURA_MANAGER_ENABLED
            ? [MANAGER_AGENT, ...raw.map(toAgent)]
            : raw.map(toAgent),
        );
    }
    pending
      .then((list) => {
        cache = list;
        setAgents(list);
      })
      .catch(() => {
        cache = AURA_MANAGER_ENABLED ? [MANAGER_AGENT] : [];
        setAgents(cache);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (cache) return;
    load();
  }, []);

  return {
    agents,
    loading,
    refresh: () => {
      cache = null;
      pending = null;
      load();
    },
  };
}

export function findAgent(id: string, agents: Agent[]): Agent | undefined {
  return agents.find((a) => a.id === id);
}

// User-facing aliases for agent ids. Short handles people actually type in
// chat mentions (`@cc /resume`) and the friendlier long forms map onto the
// canonical registry ids the backend knows. Mirrors `canonical_agent_id` in
// `aura-agents/src/lib.rs` so the frontend mention and the backend lookup
// agree on what `cc` means.
const AGENT_ALIASES: Record<string, string> = {
  cc: "claude",
  claude_code: "claude",
  "claude-code": "claude",
  claudecode: "claude",
  gem: "gemini",
  cx: "codex",
};

/** Canonical registry id for a user-typed agent handle. Lower-cases and
 *  trims, then applies the alias table; unknown ids pass through unchanged
 *  (an exact id like `claude` or `cursor` stays as-is). */
export function resolveAgentId(handle: string): string {
  const key = handle.trim().toLowerCase();
  return AGENT_ALIASES[key] ?? key;
}

/** Resolve a user-typed handle (alias or canonical id) to a discovered
 *  Agent, or undefined when no such agent is installed. */
export function findAgentByHandle(
  handle: string,
  agents: Agent[],
): Agent | undefined {
  const id = resolveAgentId(handle);
  return agents.find((a) => a.id === id);
}

function toAgent(raw: AgentInfo): Agent {
  return {
    id: raw.id,
    label: raw.label,
    monogram: raw.monogram || raw.label.charAt(0),
    description: raw.available
      ? raw.version || `via ${raw.bin}`
      : "not installed",
    available: raw.available,
    continuable: raw.continuable,
  };
}
