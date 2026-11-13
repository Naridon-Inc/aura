// The app switcher: hold ⌘⌥ and tap O to step through the apps on this
// computer that can open the workspace's folder; let go and it opens there.
//
// This file is the rules (which apps, in what order, how many fit, which
// key-up lets go) and the small store the overlay and its host share. The
// first app is the one you used last, so a quick tap reopens it without the
// panel ever drawing.

import { useSyncExternalStore } from "react";
import type { EditorInfo } from "./api";

/** The last tile: closes the switcher without opening anything. */
export const CLOSE_TILE = "__close__";
/** The OS file manager, opened on the folder itself. */
export const FILE_MANAGER = "finder";

export type SwitcherEntry = { id: string; name: string };

/** Sizes the overlay is drawn with, in px. */
export const SWITCHER_COLUMN = 110;
export const SWITCHER_TILE = 88;
export const SWITCHER_PAD_X = 24;
export const SWITCHER_PAD_Y = 28;
const SCREEN_MARGIN = 40;

/** The panel waits this long before drawing, so a quick tap opens the last
 *  app without flashing a panel on the way. */
export const SWITCHER_REVEAL_MS = 300;

/** How many tiles fit across a window this wide, Close included. */
export function tilesThatFit(viewportWidth: number): number {
  const room = viewportWidth - SCREEN_MARGIN * 2;
  return Math.max(1, Math.floor((room - SWITCHER_PAD_X * 2) / SWITCHER_COLUMN));
}

/** What this computer calls its file manager. */
export function fileManagerName(userAgent: string): string {
  if (/Mac/i.test(userAgent)) return "Finder";
  if (/Windows/i.test(userAgent)) return "File Explorer";
  return "Files";
}

/** The installed editors, then the file manager. "System default" is left
 *  out: on a folder it is the file manager again. */
export function switcherApps(apps: EditorInfo[], fileManager: string): SwitcherEntry[] {
  const editors = apps
    .filter((a) => a.available && a.id !== "default")
    .map((a) => ({ id: a.id, name: a.name }));
  return [...editors, { id: FILE_MANAGER, name: fileManager }];
}

/** Most recently used first; the rest keep the order they came in. */
export function byRecentUse(entries: SwitcherEntry[], recent: string[]): SwitcherEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const first: SwitcherEntry[] = [];
  const seen = new Set<string>();
  for (const id of recent) {
    const hit = byId.get(id);
    if (hit && !seen.has(id)) {
      first.push(hit);
      seen.add(id);
    }
  }
  return [...first, ...entries.filter((e) => !seen.has(e.id))];
}

/** The tiles for one opening: as many apps as fit, then Close. */
export function switcherEntries(
  apps: EditorInfo[],
  recent: string[],
  viewportWidth: number,
  fileManager: string,
): SwitcherEntry[] {
  const ordered = byRecentUse(switcherApps(apps, fileManager), recent);
  return [...ordered.slice(0, tilesThatFit(viewportWidth) - 1), { id: CLOSE_TILE, name: "Close" }];
}

/** An app just opened moves to the front. */
export function recordUse(recent: string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, 32);
}

/** The key-up that lets go: ⌘ (Ctrl off macOS) or ⌥, the keys the chord is
 *  held on. Shift only picks the direction, so letting it go does nothing. */
export function releasesSwitcher(e: { type: string; key: string }): boolean {
  return e.type === "keyup" && (e.key === "Meta" || e.key === "Control" || e.key === "Alt");
}

/** Where on the caption row the selected tile's name is centred: its left
 *  and right insets inside a row as wide as the tiles. */
export function captionInsets(selected: number, count: number): { left: number; right: number } {
  const centre = selected * SWITCHER_COLUMN + SWITCHER_COLUMN / 2;
  const shift = 2 * centre - count * SWITCHER_COLUMN;
  return { left: Math.max(0, shift), right: Math.max(0, -shift) };
}

const RECENT_KEY = "aura.openInRecent";

export function readRecent(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRecent(list: string[], storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // A full or blocked store only costs the ordering next time.
  }
}

export type SwitcherState = {
  active: boolean;
  selected: number;
  entries: SwitcherEntry[];
  /** The panel is drawn: the reveal delay passed, or you stepped. */
  ready: boolean;
  /** The folder the chosen app opens. */
  path: string | null;
};

const IDLE: SwitcherState = { active: false, selected: 0, entries: [], ready: false, path: null };

type Timers = {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
};

export function createSwitcherStore(
  timers: Timers = {
    schedule: (fn, ms) => globalThis.setTimeout(fn, ms),
    cancel: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let state = IDLE;
  let reveal: unknown;
  const subs = new Set<() => void>();
  const set = (next: Partial<SwitcherState>) => {
    state = { ...state, ...next };
    for (const fn of subs) fn();
  };
  const stopReveal = () => {
    if (reveal !== undefined) timers.cancel(reveal);
    reveal = undefined;
  };
  const step = (by: number) => {
    const n = state.entries.length;
    if (!state.active || n === 0) return;
    stopReveal();
    set({ selected: (((state.selected + by) % n) + n) % n, ready: true });
  };
  return {
    get: () => state,
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    activate(entries: SwitcherEntry[], path: string) {
      stopReveal();
      set({ active: true, selected: 0, entries, ready: false, path });
      reveal = timers.schedule(() => {
        reveal = undefined;
        if (state.active) set({ ready: true });
      }, SWITCHER_REVEAL_MS);
    },
    forward: () => step(1),
    backward: () => step(-1),
    select(index: number) {
      if (state.active && index >= 0 && index < state.entries.length && index !== state.selected) {
        set({ selected: index });
      }
    },
    deactivate() {
      stopReveal();
      if (state !== IDLE) set(IDLE);
    },
    selectedEntry(): SwitcherEntry | undefined {
      return state.entries[state.selected];
    },
  };
}

export const appSwitcher = createSwitcherStore();

export function useAppSwitcher(): SwitcherState {
  return useSyncExternalStore(appSwitcher.subscribe, appSwitcher.get, appSwitcher.get);
}
