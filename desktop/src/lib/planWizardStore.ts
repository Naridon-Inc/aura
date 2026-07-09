// planWizardStore — the single source of truth for the fullscreen Plan
// wizard. A proposed plan opens as an app-level overlay (PlanWizard +
// FullscreenOverlay), NOT a workpane tab: the user reads the full design
// doc and task breakdown in focus, then Builds or Cancels. One plan is
// open at a time.
//
// Tiny useSyncExternalStore store (mirrors editorStore's emit pattern):
// a private subscriber set + emit(), no zustand. The host (PlanWizardHost)
// subscribes once near the app root and mounts/unmounts the overlay.

import { useSyncExternalStore } from "react";
import type { PlanPhase, PlanTabData } from "./editorStore";

// The camelCase plan shape `pendingPlanToTabInput` produces — identical
// to what `editorStore.openPlan` accepts for a workpane tab. It lacks the
// stored-tab fields (repoRoot / sessionId / at) and the per-todo `done`
// flag; openPlanWizard fills those in so the shared PlanDocumentBody /
// PlanTasksBody render identically whether mounted in a tab or here.
export type PlanWizardInput = {
  id: string;
  title: string;
  summary: string;
  objective?: string;
  baseline?: string;
  architectureMermaid?: string;
  phases?: PlanPhase[];
  deliverables?: string[];
  tests?: string[];
  pendingPlanId?: string | null;
  todos: {
    description: string;
    agent: string | null;
    fileRefs?: string[];
    assignee?: string | null;
    suggestedProvider?: {
      providerId: string;
      score: number;
      sampleCount: number;
    } | null;
  }[];
};

let current: PlanTabData | null = null;
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

// Open the fullscreen plan wizard over the app. Mirrors
// `editorStore.openPlan`'s (input, repoRoot, sessionId) signature so call
// sites can swap one surface for the other; the only difference is where
// the plan renders (app-level overlay vs. workpane tab). Fills the
// stored-tab fields the input omits.
export function openPlanWizard(
  input: PlanWizardInput,
  repoRoot: string | null = null,
  sessionId: string | null = null,
) {
  current = {
    ...input,
    repoRoot,
    sessionId,
    at: Date.now(),
    todos: input.todos.map((t) => ({ ...t, done: false })),
  };
  emit();
}

export function closePlanWizard() {
  if (current === null) return;
  current = null;
  emit();
}

// Local "mark done" toggle — the wizard's todo checkboxes are a reading
// aid (tick off what you've eyeballed before clicking Build), not
// persisted state. Plans are session-only, so this lives only as long as
// the overlay is open.
export function togglePlanWizardTodo(idx: number) {
  if (!current) return;
  current = {
    ...current,
    todos: current.todos.map((t, i) =>
      i === idx ? { ...t, done: !t.done } : t,
    ),
  };
  emit();
}

function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): PlanTabData | null {
  return current;
}

export function usePlanWizard(): PlanTabData | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
