// Per-task agent assignment, stored in localStorage. The plan XML
// today carries an <owner> string (free-form role label like
// "Backend Developer"), not a runnable agent id, so the UI lets the
// user pin claude/gemini/codex/cursor/aura-manager per task. The
// Manager's tick loop will read these in a later phase; for now the
// chip is purely visual + drives the existing "hand-task-to-agent"
// custom event when the user picks an agent from the menu.
//
// Storage key: `aura.agent_assignments.<repoRoot>` → Record<taskKey, agentId>.
// taskKey: `plan:<wave-id>::<task-id>` for plan tasks
//          `ticket:<ticket-id>` for backlog tickets

import { useEffect, useState } from "react";

export type AgentAssignment = string; // agent id from the registry

const KEY_PREFIX = "aura.agent_assignments.";

function storageKey(repoRoot: string): string {
  return KEY_PREFIX + repoRoot;
}

function readAll(repoRoot: string): Record<string, AgentAssignment> {
  try {
    const raw = localStorage.getItem(storageKey(repoRoot));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function writeAll(repoRoot: string, map: Record<string, AgentAssignment>): void {
  try {
    localStorage.setItem(storageKey(repoRoot), JSON.stringify(map));
    window.dispatchEvent(
      new CustomEvent("aura:agent-assignments-changed", { detail: { repoRoot } }),
    );
  } catch {
    // Quota exceeded or storage disabled — best-effort.
  }
}

export function planTaskKey(waveId: string, taskId: string): string {
  return `plan:${waveId}::${taskId}`;
}

export function ticketKey(ticketId: string): string {
  return `ticket:${ticketId}`;
}

/** Subscribe to the assignment map for a repo. Returns the live map +
 *  a setter that updates a single key (or clears it when agent is null). */
export function useAgentAssignments(
  repoRoot: string,
): [Record<string, AgentAssignment>, (taskKey: string, agent: string | null) => void] {
  const [map, setMap] = useState<Record<string, AgentAssignment>>(() =>
    readAll(repoRoot),
  );

  useEffect(() => {
    setMap(readAll(repoRoot));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.repoRoot !== repoRoot) return;
      setMap(readAll(repoRoot));
    };
    window.addEventListener("aura:agent-assignments-changed", onChange);
    return () =>
      window.removeEventListener("aura:agent-assignments-changed", onChange);
  }, [repoRoot]);

  const setOne = (taskKey: string, agent: string | null) => {
    const cur = readAll(repoRoot);
    if (agent) cur[taskKey] = agent;
    else delete cur[taskKey];
    writeAll(repoRoot, cur);
    setMap({ ...cur });
  };

  return [map, setOne];
}
