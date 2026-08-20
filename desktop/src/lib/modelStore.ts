// Per-task-class model routing — the user picks which Claude model
// handles each class of brain call, and the manager forwards that
// choice to the CLI/agent layer. Defaults err on the cheap side: Haiku
// for simple edits, Sonnet for normal turns, Opus for plans.
//
// Changing a default only moves fresh installs — `read()` layers stored
// prefs over DEFAULTS, so anyone who has already chosen keeps their pick.

import { useSyncExternalStore } from "react";

export type ModelId =
  | "auto"
  | "claude-haiku-4-5"
  | "claude-sonnet-4-6"
  | "claude-sonnet-5"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
  | "claude-opus-5"
  | "claude-fable-5";

export type TaskClass = "simple_edit" | "chat" | "plan";

export type ModelPrefs = {
  /** What the StatusBar pill / composer chip shows when "Auto" is on.
   *  Per-class picks override this for the actual routing decision. */
  default: ModelId;
  byClass: Record<TaskClass, ModelId>;
};

const KEY = "aura.model.prefs.v1";

const DEFAULTS: ModelPrefs = {
  default: "auto",
  byClass: {
    simple_edit: "claude-haiku-4-5",
    chat: "claude-sonnet-5",
    plan: "claude-opus-5",
  },
};

export const MODEL_OPTIONS: { id: ModelId; label: string; hint: string }[] = [
  { id: "auto", label: "Pick per task", hint: "Aura chooses by the kind of work. Set them below" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fast + cheap. Simple edits" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced. Daily chat + refactors" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Latest balanced model. Coding + agents" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Strong. Bigger plans" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Strongest. Planning + long context" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "Frontier coding. Complex plans" },
  { id: "claude-opus-5", label: "Claude Opus 5", hint: "Frontier. Hardest coding and plans" },
  { id: "claude-fable-5", label: "Claude Fable 5", hint: "Long-horizon work. Hardest projects" },
];

export const TASK_CLASSES: { id: TaskClass; label: string; hint: string }[] = [
  { id: "simple_edit", label: "Simple edits", hint: "Single-file tweaks, renames" },
  { id: "chat", label: "Chat / refactor", hint: "Multi-turn coding, debugging" },
  { id: "plan", label: "Planning / large work", hint: "Multi-file plans, design" },
];

function read(): ModelPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ModelPrefs>;
    return {
      default: parsed.default ?? DEFAULTS.default,
      byClass: { ...DEFAULTS.byClass, ...(parsed.byClass ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

let cache: ModelPrefs = read();
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

export function getModelPrefs(): ModelPrefs {
  return cache;
}

export function setDefaultModel(id: ModelId) {
  cache = { ...cache, default: id };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
  emit();
}

export function setClassModel(cls: TaskClass, id: ModelId) {
  cache = { ...cache, byClass: { ...cache.byClass, [cls]: id } };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
  emit();
}

export function useModelPrefs(): ModelPrefs {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => cache,
    () => DEFAULTS,
  );
}

/** Friendly label for the StatusBar item. Shows the user's pick, or
 *  "Auto · <fallback>" when on Auto so they can still see what's
 *  actually running. */
export function modelLabel(prefs: ModelPrefs, runtimeModel?: string | null): string {
  if (prefs.default === "auto") {
    if (runtimeModel) return `Auto · ${runtimeModel}`;
    return "Auto";
  }
  const opt = MODEL_OPTIONS.find((m) => m.id === prefs.default);
  return opt?.label ?? "Auto";
}
