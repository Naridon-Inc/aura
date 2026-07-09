// Per-task-class model routing — the user picks which Claude model
// handles each class of brain call, and the manager forwards that
// choice to the CLI/agent layer. Defaults err on the cheap side: Haiku
// for simple edits, Sonnet for normal turns, Opus for plans.

import { useSyncExternalStore } from "react";

export type ModelId =
  | "auto"
  | "claude-haiku-4-5"
  | "claude-sonnet-4-6"
  | "claude-opus-4-6"
  | "claude-opus-4-7";

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
    chat: "claude-sonnet-4-6",
    plan: "claude-opus-4-7",
  },
};

export const MODEL_OPTIONS: { id: ModelId; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "System picks per task class" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fast + cheap — simple edits" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced — daily chat + refactors" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Strong — bigger plans" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Strongest — planning + long context" },
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
