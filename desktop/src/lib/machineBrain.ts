// A chat on one of the org's machines, as the model picker and the turn see it.
//
// Its brain is the agent on the machine (`place:<key>`), and it stays that
// brain. Once that agent's conversation has opened, the models offered are the
// ones it reported. Until then a Claude machine offers the Claude Code models
// from the catalog, so the picker names real models while the agent is still
// starting (or can't start), instead of a bare "Default". A model picked under
// any other brain is never carried to it. The backend refuses the rest
// (`registry::stays_on_machine`).

import { invoke } from "@tauri-apps/api/core";

import type { BrainChoice, ModelCatalog, ModelInfo } from "./api";
import { catalogFor, familyOf, type SelectedModel } from "./modelCatalog";

/** The provider-id family of a machine's chat (the backend's `PLACE_PREFIX`). */
export const MACHINE_BRAIN_PREFIX = "place:";

export type MachineModel = { id: string; label: string };

/** The agent a machine's chat runs. */
export type MachineEngine = "claude" | "codex";

export function isMachineBrain(brain: { id: string } | null | undefined): brain is BrainChoice {
  return !!brain && brain.id.startsWith(MACHINE_BRAIN_PREFIX);
}

/** Which agent runs on the machine. The brain carries it only in its label
 *  ("Claude on aura-runner", from `cloudBoxChat.brainFor`), and that label
 *  says Codex only for Codex, so everything else is Claude. */
export function machineEngine(machine: BrainChoice): MachineEngine {
  return /^codex\b/i.test(machine.label.trim()) ? "codex" : "claude";
}

/** The model the next turn carries. On a machine's chat it is one of that
 *  machine's models, or nothing (the agent's own default). */
export function turnModel(
  machine: BrainChoice | null,
  model: SelectedModel | null,
): SelectedModel | null {
  if (!machine || !model) return model;
  return model.brainId === machine.id ? model : null;
}

/** The Claude Code CLI, as the brain its catalog rows are listed under. */
const CLAUDE_CODE: BrainChoice = {
  id: "cli_wrapper:claude",
  label: "Claude",
  kind: "cli_wrapper",
  active: true,
  requires_api_key: false,
  has_api_key: true,
};

const CLAUDE_BRAND = { brand: "claude", brandName: "Claude" } as const;

/** The Claude Code models a Claude machine offers before its agent reports:
 *  the catalog's rows with a model id (the picker's own Auto stands in for
 *  "Default"), one per model — a 1M row shares its model's id, and the window
 *  is the agent's to choose. */
export function claudeSeed(live?: ModelCatalog | null): ModelInfo[] {
  const seen = new Set<string>();
  const rows: ModelInfo[] = [];
  for (const m of catalogFor(CLAUDE_CODE, live)) {
    if (!m.id || m.longContext || seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push({ id: m.id, label: m.label, key: m.key, isNew: m.isNew, ...CLAUDE_BRAND });
  }
  return rows;
}

/** The catalog the picker draws for a machine's chat, keyed by the ids the
 *  agent there takes. What the agent reported wins: it is the list that machine
 *  can run. Before it reports, a Claude machine offers the Claude Code models
 *  (`live` is this laptop's catalog, for their names); a Codex machine keeps
 *  to the agent's own default, since its agent's ids aren't the catalog's. */
export function machineCatalog(
  machine: BrainChoice,
  models: readonly MachineModel[],
  live?: ModelCatalog | null,
): ModelCatalog {
  const claude = machineEngine(machine) === "claude";
  const brand = claude ? CLAUDE_BRAND : {};
  const reported: ModelInfo[] = models.map((m) => ({ id: m.id, label: m.label, key: m.id, ...brand }));
  const rows = reported.length > 0 || !claude ? reported : claudeSeed(live);
  return { fetched_at: 0, cached: false, families: { [familyOf(machine)]: rows }, errors: {} };
}

/** The models the agent on the machine reported. Empty until its
 *  conversation has opened. */
export function machineModels(provider: string): Promise<MachineModel[]> {
  return invoke<MachineModel[]>("cloud_box_chat_models", { provider });
}
