// Per-task user preferences (agent override, model override, claim).
//
// Stored locally in localStorage keyed by task id. We avoid pushing
// these into A2A cloud metadata until the schema gets formal fields
// (post-launch). This keeps the UX honest — the user sees their pick
// stick across sessions on the same machine — without committing to
// a schema we haven't validated yet.
//
// When backend support lands, this module becomes a write-through cache
// over the cloud patch call. Callers don't need to change.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "aura.taskPreferences.v1";

export type TaskPreference = {
  taskId: string;
  /** Agent chosen for this task. One of the well-known agent ids
   *  ("claude", "gemini", "codex", "cursor") or a custom string. */
  agent?: string;
  /** Model id (e.g. "claude-opus-4-7"). */
  model?: string;
  /** Local assignment override. Holds whatever identifier the row UI
   *  hands us — GitHub login (from `pr_whoami`) for "Take up", or a
   *  teammate handle for "Assign to teammate". Persisted client-side
   *  until the cloud A2A row exposes a patch path for assignee. */
  assignee?: string;
};

type Store = Record<string, TaskPreference>;

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function save(s: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota or disabled — preferences become session-only. Acceptable.
  }
}

let state: Store = load();
const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

export function getTaskPreference(taskId: string): TaskPreference {
  return state[taskId] ?? { taskId };
}

export function setTaskPreference(taskId: string, patch: Partial<TaskPreference>) {
  const next: Store = { ...state };
  const prev = next[taskId] ?? { taskId };
  next[taskId] = { ...prev, ...patch, taskId };
  state = next;
  save(state);
  emit();
}

export function clearTaskPreference(taskId: string) {
  if (!state[taskId]) return;
  const next = { ...state };
  delete next[taskId];
  state = next;
  save(state);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Store {
  return state;
}

export function useTaskPreferences(): Store {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ─── recommended agent (heuristic until Skill Ledger ships per-task) ──

const AGENT_FOR_KIND: Record<string, string> = {
  // Plans + waves are high-level orchestration; default to Claude
  // (long-context reasoning).
  plan: "claude",
  wave: "claude",
  // Tasks are concrete implementation; default to Claude too — the
  // Skill Ledger override (when wired) picks the best per-task.
  task: "claude",
  subtask: "claude",
};

export function recommendedAgentFor(taskKind: string | undefined): string {
  return AGENT_FOR_KIND[taskKind ?? "task"] ?? "claude";
}

export function effectiveAgent(
  taskId: string,
  taskKind: string | undefined,
): string {
  const pref = state[taskId];
  return pref?.agent ?? recommendedAgentFor(taskKind);
}

export function effectiveModel(taskId: string): string | null {
  return state[taskId]?.model ?? null;
}

/** Resolved assignee for a task: pref override → row's
 *  `assignee_user_id` → `metadata.assignee` → null. The override wins
 *  because that's what the user explicitly picked in "Take up" or
 *  "Assign to teammate" since the row was minted. */
export function effectiveAssignee(
  taskId: string,
  rowAssigneeId: string | null | undefined,
  metadataAssignee: string | null | undefined,
): string | null {
  return state[taskId]?.assignee ?? rowAssigneeId ?? metadataAssignee ?? null;
}
