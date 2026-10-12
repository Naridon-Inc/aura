// The loadout — the handful of models you actually switch between, in the
// order you put them, with a chord on the first few.
//
// Aura already persisted a set of starred models, and the picker used it for
// exactly one thing: filling in a star icon. The set had no order anybody
// could see and no way to reach a member from the keyboard, so switching
// model stayed a click into a popover and a hunt down a list of every model
// every installed agent can run.
//
// This is the same stored list read as an ordered shortlist. No migration:
// `toggleModelFavorite` has always appended, so what is on disk is already
// insertion order — the stars somebody set last month become their slots.
//
// Two deliberate differences from Conductor's loadout, which this follows in
// shape:
//
//   * It is not capped at five. Conductor ships five fixed slots; Aura's list
//     predates this and some of them are long. Capping would silently drop
//     models a person had already chosen, so the list stays as long as they
//     want and only the first few get a chord.
//   * The chord is ⌘1…⌘5, not Conductor's ^⌘1…^⌘5. The plain ⌘-digit row is
//     unclaimed in Aura (`resolveShortcut` has no digit case but ⌘0), it is
//     the convention for "the Nth of these" everywhere else, and it is one
//     modifier shorter. Nothing is gained by copying a chord that was picked
//     around another app's conflicts.

import type { BrainChoice } from "./api";
import { rowKey, type CatalogModel } from "./modelCatalog";
import {
  loadModelFavorites,
  saveModelFavorites,
  toggleModelFavorite,
} from "./modelFavorites";

/** How many entries get a keyboard chord. Past this they are still in the
 *  loadout and still at the top of the picker — just not one key away. */
export const LOADOUT_CHORD_SLOTS = 5;

/** The loadout, in order. Shares storage with the stars (see the header). */
export function loadModelLoadout(): string[] {
  return loadModelFavorites();
}

export function saveModelLoadout(next: string[]): void {
  saveModelFavorites(next);
}

/** Add `key` if it is absent, drop it if it is present. New entries land at
 *  the end so adding one never renumbers the chords already in muscle
 *  memory. */
export function toggleLoadoutEntry(order: string[], key: string): string[] {
  return toggleModelFavorite(order, key);
}

/** `order` with the entry at `from` moved to sit at `to`. Out-of-range
 *  indices hand back the same array, so a drag that ends nowhere is a no-op
 *  rather than a reshuffle. */
export function moveLoadoutEntry(
  order: string[],
  from: number,
  to: number,
): string[] {
  if (from === to) return order;
  if (from < 0 || from >= order.length) return order;
  if (to < 0 || to >= order.length) return order;
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** `order` with `fromKey` moved to where `toKey` sits.
 *
 *  The picker drags rows it has resolved against the live catalog, which can
 *  be shorter than the stored order — an entry whose agent is uninstalled is
 *  skipped, not dropped. Positions in the drawn list therefore do not index
 *  the stored one, so a reorder travels as the two keys and is resolved here.
 *  A key the order does not hold is a no-op. */
export function moveLoadoutKey(
  order: string[],
  fromKey: string,
  toKey: string,
): string[] {
  const from = order.indexOf(fromKey);
  const to = order.indexOf(toKey);
  if (from < 0 || to < 0) return order;
  return moveLoadoutEntry(order, from, to);
}

/** What the chord for position `index` (0-based) reads as, or null past the
 *  slots that have one. The glyph, not the key: this is a label. */
export function loadoutChordLabel(index: number): string | null {
  return index < LOADOUT_CHORD_SLOTS ? `⌘${index + 1}` : null;
}

/** The loadout key a 1-based slot points at, or null when the slot is past
 *  the end — pressing ⌘4 with three models loaded does nothing rather than
 *  wrapping onto the first. */
export function loadoutSlotKey(order: string[], slot: number): string | null {
  if (slot < 1 || slot > LOADOUT_CHORD_SLOTS) return null;
  return order[slot - 1] ?? null;
}

/** One pickable (brain, model) pair, as every picker already flattens them. */
export type LoadoutRow = { brain: BrainChoice; model: CatalogModel };

/** The loadout resolved against the catalog that is actually available, in
 *  loadout order.
 *
 *  An entry whose agent is not installed right now is skipped rather than
 *  dropped: uninstall Gemini and its row disappears from the picker, install
 *  it again and the row comes back in the slot it always had. The stored list
 *  is the user's intent, not a cache of what resolved last time. */
export function resolveLoadout(
  order: string[],
  rows: readonly LoadoutRow[],
): LoadoutRow[] {
  const byKey = new Map<string, LoadoutRow>();
  for (const row of rows) {
    const key = rowKey(row.brain.id, row.model);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const out: LoadoutRow[] = [];
  for (const key of order) {
    const row = byKey.get(key);
    if (row) out.push(row);
  }
  return out;
}
