// Per-workspace customisation — the bits of a workspace that are yours rather
// than git's: what it's CALLED, its glyph, whether it's pinned, whether it's
// hidden. Storage is localStorage-only (one device, one user); we treat this as
// a UI preference, not a synced setting.
//
// API mirrors the other zustand-lite stores in `lib/` so consumers can
// subscribe via useSyncExternalStore.

import { useSyncExternalStore } from "react";

const KEY = "aura.workspace.customization.v1";

// Per-root UI state. `name` is what YOU call this workspace, overriding the
// name derived from its branch; `emoji` is the tile glyph; `pinned` floats a
// workspace to the top of the roster; `archived` (a timestamp, ms) hides it
// from the roster without touching the branch or files on disk — Restore
// clears it. `linkedWorkspaceIds` (other workspaces, by checkout root) and
// `linkedDirectoryPaths` (any folder) are what the agents started here may
// read besides it. All are per-device UI preferences, never synced, and any
// absent key means "off" (no links).
type CustomizationEntry = {
  name?: string;
  emoji?: string;
  pinned?: boolean;
  archived?: number;
  linkedWorkspaceIds?: string[];
  linkedDirectoryPaths?: string[];
};

type CustomizationMap = Record<string, CustomizationEntry>;

function read(): CustomizationMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CustomizationMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let cache: CustomizationMap = read();
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
}

// One place to merge a patch into a root's entry and prune it if it goes empty,
// so every field-setter stays a one-liner and the map never accumulates `{}`s.
function patchEntry(root: string, patch: Partial<CustomizationEntry>) {
  const entry: CustomizationEntry = { ...(cache[root] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === false) {
      delete (entry as Record<string, unknown>)[k];
    } else {
      (entry as Record<string, unknown>)[k] = v;
    }
  }
  if (Object.keys(entry).length === 0) {
    const next = { ...cache };
    delete next[root];
    cache = next;
  } else {
    cache = { ...cache, [root]: entry };
  }
  persist();
  emit();
}

/** What YOU call this workspace, or undefined when it still goes by the name
 *  derived from its branch.
 *
 *  Keyed by checkout path, not by repository: every checkout — the main one
 *  and each parallel copy — is its own root elsewhere in the app, so `main`
 *  and `feat/abc` can carry different names even though they're one repo. A
 *  branch slug is a filing code, not a name; this is where "the login fix"
 *  lives. */
export function getWorkspaceName(root: string): string | undefined {
  return cache[root]?.name;
}

/** Rename a workspace. An empty/blank name clears it, which restores the
 *  branch-derived name rather than leaving the row nameless. */
export function setWorkspaceName(root: string, name: string | undefined) {
  patchEntry(root, { name: name && name.trim() ? name.trim() : undefined });
}

export function getWorkspaceEmoji(root: string): string | undefined {
  return cache[root]?.emoji;
}

export function setWorkspaceEmoji(root: string, emoji: string | undefined) {
  patchEntry(root, { emoji: emoji && emoji.trim() ? emoji.trim() : undefined });
}

/** Whether a workspace is pinned to the top of the roster. */
export function isWorkspacePinned(root: string): boolean {
  return !!cache[root]?.pinned;
}

export function setWorkspacePinned(root: string, pinned: boolean) {
  patchEntry(root, { pinned: pinned || undefined });
}

/** When the workspace was archived (ms), or undefined if it's active. */
export function getWorkspaceArchivedAt(root: string): number | undefined {
  return cache[root]?.archived;
}

export function isWorkspaceArchived(root: string): boolean {
  return typeof cache[root]?.archived === "number";
}

const archivedHooks = new Set<(root: string) => void>();

/** Called once each time a workspace goes from active to archived, wherever
 *  the archive was asked for (sidebar, palette, shortcut, review header). */
export function onWorkspaceArchived(hook: (root: string) => void): () => void {
  archivedHooks.add(hook);
  return () => {
    archivedHooks.delete(hook);
  };
}

/** Archive hides a workspace from the roster; the branch + files stay on disk.
 *  Pass `false` (or restore) to bring it back. Archiving also clears any pin. */
export function setWorkspaceArchived(root: string, archived: boolean, atMs?: number) {
  if (archived) {
    const was = isWorkspaceArchived(root);
    patchEntry(root, { archived: atMs ?? Date.now(), pinned: undefined });
    if (!was) for (const hook of archivedHooks) hook(root);
  } else {
    patchEntry(root, { archived: undefined });
  }
}

// ── Links ──────────────────────────────────────────────────────────────────
// A workspace can be linked to other workspaces and to plain folders, so the
// agents started in it can read them too. An entry written before links
// existed has neither key, which reads as no links.

const NO_LINKS: readonly string[] = Object.freeze([]);

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return NO_LINKS;
  return value.every((v) => typeof v === "string" && v.length > 0)
    ? (value as string[])
    : value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** The workspaces (checkout roots) linked to this one. */
export function getLinkedWorkspaceIds(root: string): readonly string[] {
  return stringsOf(cache[root]?.linkedWorkspaceIds);
}

/** The folders linked to this workspace. */
export function getLinkedDirectoryPaths(root: string): readonly string[] {
  return stringsOf(cache[root]?.linkedDirectoryPaths);
}

type LinkKey = "linkedWorkspaceIds" | "linkedDirectoryPaths";

function setLinked(root: string, key: LinkKey, next: readonly string[]) {
  patchEntry(root, { [key]: next.length > 0 ? [...next] : undefined });
}

function addLink(root: string, key: LinkKey, value: string) {
  const v = value.trim();
  const current = stringsOf(cache[root]?.[key]);
  if (!v || v === root || current.includes(v)) return;
  setLinked(root, key, [...current, v]);
}

function removeLink(root: string, key: LinkKey, value: string) {
  const current = stringsOf(cache[root]?.[key]);
  if (!current.includes(value)) return;
  setLinked(root, key, current.filter((v) => v !== value));
}

export function linkWorkspace(root: string, otherRoot: string) {
  addLink(root, "linkedWorkspaceIds", otherRoot);
}

export function unlinkWorkspace(root: string, otherRoot: string) {
  removeLink(root, "linkedWorkspaceIds", otherRoot);
}

export function linkDirectory(root: string, path: string) {
  addLink(root, "linkedDirectoryPaths", path);
}

export function unlinkDirectory(root: string, path: string) {
  removeLink(root, "linkedDirectoryPaths", path);
}

/** The folders an agent started in `root` is handed: linked workspaces that
 *  aren't archived, then linked folders, each once. A link to something
 *  deleted since is dropped by the launch itself, which can see the disk. */
export function linkedDirsForLaunch(root: string): string[] {
  if (!root) return [];
  const out: string[] = [];
  for (const id of getLinkedWorkspaceIds(root)) {
    if (!isWorkspaceArchived(id) && !out.includes(id)) out.push(id);
  }
  for (const path of getLinkedDirectoryPaths(root)) {
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** Both link lists for one workspace, re-read when either changes. */
export function useWorkspaceLinks(root: string): {
  workspaceIds: readonly string[];
  directoryPaths: readonly string[];
} {
  const map = useWorkspaceCustomization();
  const entry = map[root];
  return {
    workspaceIds: stringsOf(entry?.linkedWorkspaceIds),
    directoryPaths: stringsOf(entry?.linkedDirectoryPaths),
  };
}

export function useWorkspaceCustomization(): CustomizationMap {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => cache,
    () => ({}),
  );
}

// Small curated palette so the user doesn't have to fight the OS emoji
// picker for the 90% case (work / project / language tags).
export const EMOJI_PRESETS = [
  "🧪", "⚙️", "🚀", "🛠️", "📦", "🧠", "🎨", "🧵",
  "🪐", "🌊", "🔥", "⚡", "🌱", "🌟", "🧱", "🧰",
  "📚", "💼", "🎯", "🧭", "💡", "🪄", "🧩", "📈",
] as const;

// Emoji → tile accent colour. When the user explicitly picks an emoji,
// the rail's hash-derived cool-only palette gets overridden so the
// chosen glyph reads against a tint that matches its natural colour.
// (The hash palette deliberately banned warm hues because random
// assignment of orange/yellow to a folder glyph looked like a yellow
// folder icon. Once the user opts into 🔥 they expect orange.)
//
// Values use the same rgb() form as the hash palette so the
// color-mix() callsite stays uniform.
const EMOJI_ACCENTS: Record<string, string> = {
  "🧪": "rgb(110 231 183)", // emerald — lab green
  "⚙️": "rgb(148 163 184)", // slate — metal grey
  "🚀": "rgb(252 165 165)", // rose — propulsion
  "🛠️": "rgb(251 191 36)",  // amber — tools
  "📦": "rgb(217 119 6)",   // amber-700 — cardboard
  "🧠": "rgb(244 114 182)", // pink — brain
  "🎨": "rgb(196 181 253)", // violet — multicolour stand-in
  "🧵": "rgb(252 165 165)", // rose — thread
  "🪐": "rgb(165 180 252)", // indigo — ringed planet
  "🌊": "rgb(103 232 249)", // cyan — wave
  "🔥": "rgb(251 113 36)",  // orange — fire (user opt-in)
  "⚡": "rgb(251 191 36)",  // amber — lightning
  "🌱": "rgb(110 231 183)", // emerald — sprout
  "🌟": "rgb(251 191 36)",  // amber — star
  "🧱": "rgb(217 119 6)",   // amber-700 — brick
  "🧰": "rgb(251 191 36)",  // amber — toolbox
  "📚": "rgb(125 211 252)", // sky — books
  "💼": "rgb(217 119 6)",   // amber-700 — briefcase
  "🎯": "rgb(252 165 165)", // rose — bullseye
  "🧭": "rgb(217 119 6)",   // amber-700 — compass brass
  "💡": "rgb(251 191 36)",  // amber — bulb
  "🪄": "rgb(196 181 253)", // violet — wand
  "🧩": "rgb(110 231 183)", // emerald — puzzle
  "📈": "rgb(110 231 183)", // emerald — growth chart
};

/** Accent colour for a chosen emoji, or undefined if we have no
 *  curated mapping (in which case the caller should fall back to the
 *  hash-derived palette). */
export function accentForEmoji(emoji: string | undefined): string | undefined {
  if (!emoji) return undefined;
  return EMOJI_ACCENTS[emoji];
}
