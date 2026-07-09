// Per-workspace customisation — currently just an emoji glyph that
// replaces the auto-generated letter on the WorkspaceRail tile. Storage
// is localStorage-only (one device, one user); we treat this as a UI
// preference, not a synced setting.
//
// API mirrors the other zustand-lite stores in `lib/` so consumers can
// subscribe via useSyncExternalStore.

import { useSyncExternalStore } from "react";

const KEY = "aura.workspace.customization.v1";

type CustomizationMap = Record<string, { emoji?: string }>;

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

export function getWorkspaceEmoji(root: string): string | undefined {
  return cache[root]?.emoji;
}

export function setWorkspaceEmoji(root: string, emoji: string | undefined) {
  const entry = { ...(cache[root] ?? {}) };
  if (emoji && emoji.trim()) {
    entry.emoji = emoji.trim();
  } else {
    delete entry.emoji;
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
