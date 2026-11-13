// The catalog, as the rows the shared model picker draws.
//
// The picker takes one flat list of options keyed by id. Here every
// (brain, model) pair becomes one option keyed by its loadout key, so the
// loadout the picker shows, reorders and saves is the same list the stars
// always wrote. The loadout leads, in its own order, with its ⌘ chords; the
// rest of the catalog follows.

import { createElement } from "react";
import type { BrainChoice, ModelCatalog, ReasoningEffort } from "../../../lib/api";
import {
  catalogFor,
  familyOf,
  modelBrandId,
  rowKey,
  type CatalogModel,
} from "../../../lib/modelCatalog";
import { loadoutChordLabel, resolveLoadout } from "../../../lib/modelLoadout";
import { AgentIcon } from "../../ui/agent-icon";
import type { ModelOption } from "../../ui/model-picker";

/** The option that follows the agent's own choice rather than naming a model. */
export const AUTO_MODEL_ID = "auto";

export type CatalogRow = { brain: BrainChoice; model: CatalogModel };

/** The Effort ladder. `null` leaves the model at its own depth; the backend
 *  translates the rest into each provider's real reasoning knob. Five rungs,
 *  because that is all the backend can send: Max already goes out as High for
 *  Codex, and A rung that lies about what it does is worse than no rung. */
export const EFFORT_LEVELS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

/** The level's name for the picker, or nothing when the model sets its own. */
export function effortLabel(effort: ReasoningEffort | null): string | undefined {
  if (effort == null) return undefined;
  return EFFORT_LEVELS.find((level) => level.value === effort)?.label;
}

export function effortValue(label: string | undefined): ReasoningEffort | null {
  return EFFORT_LEVELS.find((level) => level.label === label)?.value ?? null;
}

/** A brain that needs an API key the keychain doesn't hold can't run. */
export function isUnusable(brain: BrainChoice): boolean {
  return brain.requires_api_key && !brain.has_api_key;
}

export function catalogOptions({
  brains,
  live,
  favorites,
  auto,
  efforts = false,
  fast = false,
}: {
  brains: readonly BrainChoice[];
  live: ModelCatalog | null;
  favorites: readonly string[];
  /** The first row, when the host has a "no particular model" choice. */
  auto?: { name: string; provider: string; disabled?: boolean };
  /** Whether this host sends an Effort level / Fast with the turn. */
  efforts?: boolean;
  fast?: boolean;
}): { options: ModelOption[]; rows: Map<string, CatalogRow>; loadout: string[] } {
  const ladder = efforts ? EFFORT_LEVELS.map((level) => level.label) : undefined;
  const all: CatalogRow[] = [];
  for (const brain of brains)
    for (const model of catalogFor(brain, live)) all.push({ brain, model });
  const rows = new Map<string, CatalogRow>();
  for (const row of all) {
    const key = rowKey(row.brain.id, row.model);
    if (!rows.has(key)) rows.set(key, row);
  }
  const loadout = resolveLoadout([...favorites], all).map((row) =>
    rowKey(row.brain.id, row.model),
  );
  const option = (id: string, row: CatalogRow, shortcut?: string | null): ModelOption => ({
    id,
    name: row.model.label,
    provider: row.brain.label,
    // Branded by who makes the model, not the brain it routes through, so an
    // Opus row wears the Claude mark under any brain.
    icon: createElement(AgentIcon, {
      provider: modelBrandId(familyOf(row.brain), row.brain.id, row.model),
    }),
    shortcut: shortcut ?? undefined,
    disabled: isUnusable(row.brain),
    efforts: ladder,
    fast,
  });
  const options: ModelOption[] = [];
  if (auto)
    options.push({
      id: AUTO_MODEL_ID,
      name: auto.name,
      provider: auto.provider,
      disabled: auto.disabled,
      efforts: ladder,
      fast,
    });
  loadout.forEach((id, index) => options.push(option(id, rows.get(id)!, loadoutChordLabel(index))));
  for (const [id, row] of rows) if (!loadout.includes(id)) options.push(option(id, row));
  return { options, rows, loadout };
}

/** The stored loadout after the picker reorders the rows it shows: the shown
 *  entries take the new order, and entries for agents not installed right now
 *  keep their place at the end rather than being dropped. */
export function reorderedLoadout(stored: readonly string[], ids: readonly string[]): string[] {
  const shown = ids.filter((id) => stored.includes(id));
  return [...shown, ...stored.filter((id) => !shown.includes(id))];
}

/** The stored loadout after the picker's Add models dialog checks or clears a
 *  row: the rows it now shows, in order, and the entries it cannot show (an
 *  agent not installed right now) kept after them rather than dropped. Auto is
 *  always listed, so it is never stored. */
export function shownLoadout(
  stored: readonly string[],
  ids: readonly string[],
  rows: ReadonlyMap<string, CatalogRow>,
): string[] {
  const shown = ids.filter((id) => id !== AUTO_MODEL_ID && rows.has(id));
  return [...shown, ...stored.filter((id) => !rows.has(id) && !shown.includes(id))];
}
