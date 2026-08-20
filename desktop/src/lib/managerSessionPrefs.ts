// Per-session composer prefs for an Aura chat: which model the next turn runs
// on, and which brain (engine) it routes through.
//
// These lived inside ManagerChatView, which meant only a mounted chat could
// read or write them. A session can be *created* somewhere else entirely —
// launching a workspace opens a fresh Aura chat with the objective already in
// it — and that caller needs to set the chip BEFORE the view mounts, because
// ManagerChatView seeds `modelOverride` from storage in an effect keyed on the
// session id and never looks again. Writing after the mount left the chat
// showing no model while the turn ran on one.
//
// Model and brain are stored as a pair on purpose: the picker lifts both, and
// persisting only the model used to restore a chip ("Gemini 3 Flash") while the
// brain reset to null — so the next turn silently ran on the globally-active
// brain instead. Chip and engine must agree.

import type { BrainChoice } from "./api";
import type { SelectedModel } from "./modelCatalog";

const MODEL_KEY = (sid: string) => `aura.manager.model.${sid}`;
const BRAIN_KEY = (sid: string) => `aura.manager.brain.${sid}`;

export function loadSessionModel(sid: string): SelectedModel | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY(sid));
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<SelectedModel> | null;
    if (!m || typeof m.brainId !== "string" || typeof m.label !== "string") {
      return null;
    }
    return {
      brainId: m.brainId,
      modelId: typeof m.modelId === "string" ? m.modelId : null,
      longContext: !!m.longContext,
      label: m.label,
      family: (m.family as SelectedModel["family"]) ?? "generic",
    };
  } catch {
    return null;
  }
}

export function saveSessionModel(sid: string, model: SelectedModel | null): void {
  try {
    if (!model) localStorage.removeItem(MODEL_KEY(sid));
    else localStorage.setItem(MODEL_KEY(sid), JSON.stringify(model));
  } catch {
    /* storage disabled / quota exceeded */
  }
}

export function loadSessionBrain(sid: string): BrainChoice | null {
  try {
    const raw = localStorage.getItem(BRAIN_KEY(sid));
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<BrainChoice> | null;
    if (!b || typeof b.id !== "string") return null;
    return b as BrainChoice;
  } catch {
    return null;
  }
}

export function saveSessionBrain(sid: string, brain: BrainChoice | null): void {
  try {
    if (!brain) localStorage.removeItem(BRAIN_KEY(sid));
    else localStorage.setItem(BRAIN_KEY(sid), JSON.stringify(brain));
  } catch {
    /* storage disabled / quota exceeded */
  }
}
