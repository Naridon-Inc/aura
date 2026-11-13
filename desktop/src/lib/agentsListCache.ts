// The coding agents this machine has, read once and shared by every surface.
//
// `agents_list` names every agent CLI Aura knows and asks each installed one
// for its version. Settings → Agents, Default models, the workspace landing
// row, opening a workspace, the plan tab, Resume elsewhere and the manager
// each used to ask on their own, every time they opened, and each answer
// spawned a process per CLI. Now they share one cached answer:
//
//   - kept across restarts, so the panes paint at once even on a cold start
//     (it describes this machine, not an account);
//   - not re-read within FRESH_MS of the last read;
//   - "Look again" re-probes in the backend (forgetting where binaries were
//     found and what version they were) and writes the result here, and every
//     surface showing the list hears it.
//
// The backend keeps its own cache of versions too (aura_agents::version_cache),
// so a re-read after FRESH_MS costs milliseconds, not seconds.

import { api, type AgentDescriptor } from "./api";
import { readCached, useCachedResource } from "./useCachedResource";

export const AGENTS_LIST_KEY = "agents:list";

/** How long a read of the list is shown without asking again. */
const FRESH_MS = 60_000;

const list = () => api.agentsList();
const reread = () => api.agentsReload();

/** The list, from the shared cache when it is fresh. */
export function readAgentsList(): Promise<AgentDescriptor[]> {
  return readCached(AGENTS_LIST_KEY, list, { persist: true, freshMs: FRESH_MS });
}

/** The ids of the agents that can run here, or [] when the list can't be read. */
export async function installedAgentIds(): Promise<string[]> {
  return (await readAgentsList()).filter((a) => a.available).map((a) => a.id);
}

/** Probe again for real: something was installed, removed or upgraded. */
export function lookAgainForAgents(): Promise<AgentDescriptor[]> {
  return readCached(AGENTS_LIST_KEY, reread, { persist: true, force: true });
}

/** The list for a component: the last answer at once, then a background
 *  read when the last one is older than FRESH_MS. */
export function useAgentsList(enabled = true) {
  return useCachedResource(AGENTS_LIST_KEY, list, { persist: true, freshMs: FRESH_MS, enabled });
}
