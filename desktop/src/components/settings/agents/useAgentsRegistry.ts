// The agents this machine has, the ones declared in ~/.aura/agents.toml and
// the install health of each binary. Editing an entry here is the same write
// the CLI makes, so a change lands for every surface that starts an agent.
//
// All three are cached answers (lib/agentsList, the shared install-health
// store, and the agents.toml read below), so reopening the pane shows the last
// answer at once instead of "Looking for coding agents…" while every CLI on
// the machine is asked for its version again.

import { useCallback, useState } from "react";

import {
  api,
  type AgentDescriptor,
  type AgentInstallHealth,
  type AgentsTomlEntry,
} from "../../../lib/api";
import { lookAgainForAgents, useAgentsList } from "../../../lib/agentsListCache";
import { loadInstallHealth, useInstallRows } from "../../../lib/agentInstallHealth";
import { readCached, useCachedResource } from "../../../lib/useCachedResource";

export interface AgentsRegistry {
  registry: AgentDescriptor[];
  tomlEntries: AgentsTomlEntry[];
  installs: AgentInstallHealth[];
  /** True once there is an answer to show, so the page can tell "still
   *  looking" from "found nothing". */
  loaded: boolean;
  busy: boolean;
  error: string | null;
  lookAgain: () => Promise<void>;
  upsert: (entry: AgentsTomlEntry) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const TOML_KEY = "agents:toml";
const readToml = () => api.settingsAgentsTomlList();

export function useAgentsRegistry(): AgentsRegistry {
  const list = useAgentsList();
  const toml = useCachedResource(TOML_KEY, readToml, { persist: true });
  // Separate from the lists: it spawns a process per copy of every agent
  // binary on PATH, so it must never hold up the tabs.
  const installs = useInstallRows();
  const [looking, setLooking] = useState(false);
  const [lookError, setLookError] = useState<string | null>(null);

  // "Look again" re-reads PATH, versions and agents.toml in the backend, not
  // only the lists this page holds; the shared cache tells every other surface.
  const lookAgain = useCallback(async () => {
    setLooking(true);
    setLookError(null);
    try {
      await Promise.all([
        lookAgainForAgents(),
        readCached(TOML_KEY, readToml, { persist: true, force: true }),
      ]);
    } catch (e) {
      setLookError(String(e));
    } finally {
      setLooking(false);
    }
    void loadInstallHealth(true);
  }, []);

  const upsert = useCallback(
    async (entry: AgentsTomlEntry) => {
      await api.settingsAgentsTomlUpsert(entry);
      await lookAgain();
    },
    [lookAgain],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.settingsAgentsTomlRemove(id);
      await lookAgain();
    },
    [lookAgain],
  );

  return {
    registry: list.data ?? [],
    tomlEntries: toml.data ?? [],
    installs,
    loaded: list.data !== undefined || list.staleError !== null,
    busy: looking || list.loading,
    error: lookError ?? list.staleError ?? toml.staleError,
    lookAgain,
    upsert,
    remove,
  };
}
