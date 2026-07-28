// Keyboard shortcuts — one canonical map, two surfaces.
//
// This is the single source of truth for every global shortcut Aura ships.
// It feeds both the ⌘/ cheat-sheet (ShortcutsDialog) and the Settings →
// Help table (HELP_SHORTCUTS), so a binding is described in exactly one
// place. Every combo below is wired somewhere real (App.tsx keydown hubs,
// CommandPalette, or the editor) — we never list an aspirational key.
//
// Plain-language labels on purpose: the audience is non-engineers, so
// "Reopen closed tab" beats "restore buffer", and glyphs (⌘ ⇧ ⌥) carry the
// keys, not spelled-out modifier names.

export type Shortcut = { label: string; keys: string };
export type ShortcutGroup = { title: string; items: Shortcut[] };

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Find your way around",
    items: [
      { label: "Command palette", keys: "⌘K" },
      { label: "Search across files", keys: "⌘⇧F" },
      { label: "Open tasks board", keys: "⌘T" },
      { label: "Open team notes", keys: "⌘⇧N" },
      { label: "See every parallel copy", keys: "⌘⇧W" },
      { label: "Open settings", keys: "⌘," },
      { label: "Show all shortcuts", keys: "⌘/" },
      { label: "Next workspace", keys: "⌘⌥↓" },
      { label: "Previous workspace", keys: "⌘⌥↑" },
    ],
  },
  {
    title: "Chat & agents",
    items: [
      { label: "New chat", keys: "⌘N" },
      { label: "Log task intent", keys: "⌘⇧I" },
    ],
  },
  {
    title: "Panels & tabs",
    items: [
      { label: "Toggle sidebar", keys: "⌘B" },
      { label: "Toggle terminal", keys: "⌘J" },
      { label: "Toggle review panel", keys: "⌘R" },
      { label: "Close tab", keys: "⌘W" },
      { label: "Reopen closed tab", keys: "⌘⇧T" },
    ],
  },
  {
    title: "Files & history",
    items: [
      { label: "Save file", keys: "⌘S" },
      { label: "Open Time machine", keys: "⌘⌥T" },
    ],
  },
];

// Flat list, in group order — the Settings → Help table renders this so it
// stays in lock-step with the cheat-sheet without a second array.
export const HELP_SHORTCUTS: Shortcut[] = SHORTCUT_GROUPS.flatMap((g) => g.items);

// Split a combo string ("⌘⇧F") into its individual key caps (["⌘","⇧","F"]).
// Every glyph and letter in our combos is a single code point, so a plain
// character split is exact — no combo here has a multi-letter cap.
export function comboKeys(combo: string): string[] {
  return Array.from(combo);
}
