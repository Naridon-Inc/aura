// The model a new session starts on. The new-session picker reads it once,
// when it opens with nothing chosen: a concrete model is preselected there,
// and "auto" leaves the agent on its own default.
//
// There used to be a per-task table under it (simple edits, chat, plans),
// saved here and read by nothing; every session ran the same whatever it
// said, so it went. A `byClass` left in storage by it is ignored.

import { useSyncExternalStore } from "react";

export type ModelId =
  | "auto"
  | "claude-haiku-4-5"
  | "claude-haiku-5-5"
  | "claude-sonnet-4-6"
  | "claude-sonnet-5"
  | "claude-sonnet-5-5"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
  | "claude-opus-5"
  | "claude-opus-5-5"
  | "claude-fable-5"
  | "claude-fable-5-1";

export type ModelPrefs = {
  /** The model a new session starts on; "auto" = the agent's own default. */
  default: ModelId;
};

const KEY = "aura.model.prefs.v1";

const DEFAULTS: ModelPrefs = { default: "auto" };

export const MODEL_OPTIONS: { id: ModelId; label: string; hint: string }[] = [
  { id: "auto", label: "The agent's own default", hint: "New sessions open on whatever model the agent picks itself" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fast + cheap. Simple edits" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest answers. Quick questions + small edits" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced. Daily chat + refactors" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Balanced. Coding + agents" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Latest balanced model. Routine work, done efficiently" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Strong. Bigger plans" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Strongest. Planning + long context" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "Frontier coding. Complex plans" },
  { id: "claude-opus-5", label: "Claude Opus 5", hint: "Frontier. Hardest coding and plans" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Latest Opus. Everyday and complex work" },
  { id: "claude-fable-5", label: "Claude Fable 5", hint: "Long-horizon work. Hardest problems" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "Newest Fable. Longest-running work" },
];

function read(): ModelPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ModelPrefs>;
    return { default: parsed.default ?? DEFAULTS.default };
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
