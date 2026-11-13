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
// Two deliberate differences from the loadout pattern this follows in
// shape:
//
//   * It is not capped at five. That pattern ships five fixed slots; Aura's
//     predates this and some of them are long. Capping would silently drop
//     models a person had already chosen, so the list stays as long as they
//     want and only the first few get a chord.
//   * The chord is ⌘1…⌘5, not ^⌘1…^⌘5. The plain ⌘-digit row is
//     unclaimed in Aura (`resolveShortcut` has no digit case but ⌘0), it is
//     the convention for "the Nth of these" everywhere else, and it is one
//     modifier shorter. Nothing is gained by copying a chord that was picked
//     around another app's conflicts.

import { useSyncExternalStore } from "react";
import type { BrainChoice, ReasoningEffort } from "./api";
import { rowKey, type CatalogModel } from "./modelCatalog";
import { isRetiredRowKey } from "./retiredBrains";
import {
  MODEL_FAVORITES_KEY,
  loadModelFavorites,
  saveModelFavorites,
  toggleModelFavorite,
} from "./modelFavorites";

/** How many entries get a keyboard chord. Past this they are still in the
 *  loadout and still at the top of the picker — just not one key away. */
export const LOADOUT_CHORD_SLOTS = 5;

// One live copy of the loadout for every reader. Settings sits over the
// chats rather than replacing them, so a picker that read the list once when
// it mounted kept leading with — and chording to — the old loadout until the
// app restarted, and its next star or reorder wrote the old list back.
// Every write goes through `saveModelLoadout`, which tells every reader; a
// write from another window arrives as a `storage` event.
let current: string[] | undefined;
let currentEfforts: LoadoutEfforts | undefined;
const readers = new Set<() => void>();

function tell(): void {
  for (const reader of readers) reader();
}

function onStorage(event: StorageEvent): void {
  if (
    event.key !== null &&
    event.key !== MODEL_FAVORITES_KEY &&
    event.key !== LOADOUT_EFFORTS_KEY
  )
    return;
  current = undefined;
  currentEfforts = undefined;
  tell();
}

/** The loadout, in order. Shares storage with the stars (see the header).
 *  The same array until the loadout changes, so treat it as read-only. */
export function loadModelLoadout(): string[] {
  current ??= loadModelFavorites();
  return current;
}

/** Follow the loadout: `reader` runs after every change. */
export function subscribeModelLoadout(reader: () => void): () => void {
  readers.add(reader);
  if (readers.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    readers.delete(reader);
    if (readers.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

/** The loadout as it is now, kept current while the component is mounted. */
export function useModelLoadout(): string[] {
  return useSyncExternalStore(subscribeModelLoadout, loadModelLoadout, loadModelLoadout);
}

export function saveModelLoadout(next: string[]): void {
  saveModelFavorites(next);
  current = next.slice();
  tell();
}

// ── each slot's effort ───────────────────────────────────────────────────
//
// A slot in Settings > Models carries an effort as well as a model, and the
// chat's picker uses it when that slot's model is picked. It used to be the
// settings component's own state, so it was gone the moment Settings closed
// and the chat never saw it.
//
// Keyed by the same loadout key as the slot. `null` is a real answer — the
// slot asks for the model's own depth — and is kept apart from a slot nobody
// set, which leaves the chat's effort as it is.

/** Where each slot's effort is kept. */
export const LOADOUT_EFFORTS_KEY = "aura.model.loadoutEfforts.v1";

export type LoadoutEfforts = Readonly<Record<string, ReasoningEffort | null>>;

const EFFORTS: ReadonlySet<unknown> = new Set(["low", "medium", "high", "max", null]);

function readLoadoutEfforts(): LoadoutEfforts {
  try {
    const raw = localStorage.getItem(LOADOUT_EFFORTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ReasoningEffort | null> = {};
    for (const [key, value] of Object.entries(parsed))
      if (EFFORTS.has(value) && !isRetiredRowKey(key))
        out[key] = value as ReasoningEffort | null;
    return out;
  } catch {
    return {};
  }
}

/** Every slot's effort. The same object until one changes. */
export function loadLoadoutEfforts(): LoadoutEfforts {
  currentEfforts ??= readLoadoutEfforts();
  return currentEfforts;
}

/** The effort saved for `key`'s slot: a level, `null` for the model's own
 *  depth, or `undefined` when nobody set one. */
export function loadoutEffortFor(key: string): ReasoningEffort | null | undefined {
  const efforts = loadLoadoutEfforts();
  return Object.prototype.hasOwnProperty.call(efforts, key) ? efforts[key] : undefined;
}

/** Save `effort` for `key`'s slot and tell every reader. */
export function saveLoadoutEffort(key: string, effort: ReasoningEffort | null): void {
  const next = { ...loadLoadoutEfforts(), [key]: effort };
  try {
    localStorage.setItem(LOADOUT_EFFORTS_KEY, JSON.stringify(next));
  } catch {
    /* quota or no storage: still live for this window */
  }
  currentEfforts = next;
  tell();
}

/** Every slot's effort, kept current while the component is mounted. */
export function useLoadoutEfforts(): LoadoutEfforts {
  return useSyncExternalStore(subscribeModelLoadout, loadLoadoutEfforts, loadLoadoutEfforts);
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
