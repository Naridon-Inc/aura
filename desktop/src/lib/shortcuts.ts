// Keyboard shortcuts — one canonical map, three surfaces.
//
// This is the single source of truth for every shortcut Aura ships. It feeds
// the ⌘/ cheat-sheet (ShortcutsDialog), the Settings → Help table, and the
// tasks board, so a binding is described in exactly one place. Every combo
// below is wired somewhere real — a keydown hub in App.tsx, the global switch
// in lib/keymap.ts, a surface's own effect, or a native menu accelerator in
// src-tauri/src/menu.rs. We never list an aspirational key, and the claim is
// only worth anything if it's checked: three entries had drifted (⌘R had
// moved to Reload, ⌘⇧N was answered by two different handlers at once, and
// the review panel had quietly become ⌘⌥R) before anyone read the handlers
// back against the list. Change a binding, change this file.
//
// ── The claim used to run only one way ────────────────────────────────────
//
// It said "every GLOBAL shortcut", and every key it listed was real. What it
// never promised was the converse, and the converse is what a cheat-sheet is
// for: the app bound keys, printed them on screen, and left them out of here.
//
//   • The tasks board shipped a second cheat-sheet of its own — ten card keys
//     behind `?`, a key documented only inside the sheet it opens. The only
//     way to learn `?` existed was to have already pressed it.
//   • Four more were advertised in the UI and absent here: ⌘L to jump to the
//     message box, ⌘O to upload, ⌘⇧Enter for a code block, ⏎/Esc on a plan.
//
// Meanwhile this file's own entry read "Show all shortcuts — ⌘/". So a group
// can now carry a `note` saying where it applies, and everything the app
// binds lives here, scoped honestly, rather than being split across two
// sheets by whether it happened to be global.
//
// Plain-language labels on purpose: the audience is non-engineers, so
// "Reopen closed tab" beats "restore buffer", and glyphs (⌘ ⇧ ⌥) carry the
// keys, not spelled-out modifier names.

export type Shortcut = { label: string; keys: string };
export type ShortcutGroup = {
  title: string;
  /** Where these keys apply, for groups that aren't global. Rendered under
   *  the heading — a scoped key with no scope printed is worse than an
   *  absent one, because you try it on the wrong screen and conclude the
   *  app is broken. */
  note?: string;
  items: Shortcut[];
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Find your way around",
    items: [
      { label: "Open Aura", keys: "⌘⌥A" },
      { label: "Command palette", keys: "⌘K" },
      { label: "Search across files", keys: "⌘⇧F" },
      { label: "Open tasks board", keys: "⌘T" },
      { label: "Open the daily standup", keys: "⌘⇧U" },
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
      { label: "New parallel copy", keys: "⌘⇧N" },
      { label: "Log task intent", keys: "⌘⇧I" },
    ],
  },
  {
    title: "Panels & tabs",
    items: [
      { label: "Toggle sidebar", keys: "⌘B" },
      { label: "Toggle terminal", keys: "⌘J" },
      { label: "Toggle review panel", keys: "⌘⌥R" },
      { label: "Reload the app", keys: "⌘R" },
      { label: "New browser tab", keys: "⌘⇧B" },
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
  {
    // ⌘L: EditorInlineComposer.tsx, ManagerComposer.tsx.
    // ⌘O and ⌘⇧Enter: team/presentation/Composer.tsx, which prints both in
    // its add-menu — the app was telling you about keys this file didn't
    // know existed.
    title: "Writing a message",
    note: "Anywhere there's a message box",
    items: [
      { label: "Jump to the message box", keys: "⌘L" },
      { label: "Insert a code block", keys: "⌘⇧Enter" },
      { label: "Upload a file", keys: "⌘O" },
    ],
  },
  {
    // ManagerChatView.tsx binds these on the plan card while it is open.
    title: "When Aura hands you a plan",
    note: "While the plan card is open",
    items: [
      { label: "Build it", keys: "Enter" },
      { label: "Cancel the plan", keys: "Esc" },
    ],
  },
  {
    // These were `TASK_SHORTCUTS`, next to their bindings in
    // components/tasks/useTaskShortcuts.ts and read by a second cheat-sheet
    // the board drew for itself. The hook still binds them; the list of what
    // they do belongs with every other list of what a key does. Proximity was
    // the old sync mechanism — tests/shortcuts.test.ts reads the hook and
    // asserts this group and its bindings match in both directions.
    title: "On a task card",
    note: "Click a card to focus it first",
    items: [
      { label: "Open the task", keys: "Enter" },
      { label: "Close it / deselect", keys: "Esc" },
      { label: "Peek without leaving the board", keys: "⇧+click" },
      { label: "Change who's on it", keys: "a" },
      { label: "Change priority", keys: "p" },
      { label: "Change status", keys: "s" },
      { label: "Add a label", keys: "l" },
      { label: "Copy the task's ID", keys: "c" },
      { label: "Delete the task", keys: "d" },
      { label: "Show this list", keys: "?" },
    ],
  },
];

// There used to be a flat `HELP_SHORTCUTS` here, the whole map spread into one
// array, and the Settings → Help table was its only reader. A flat list is
// exactly what stopped working: `Enter` opens a task on a focused card and
// builds a plan on a plan card, so printed as two adjacent rows with no
// headings they read as a contradiction. Both surfaces render the groups now.
// Anything that genuinely wants every binding at once can flatMap in one line —
// it doesn't need an export kept warm on the chance that it might.

/** Split a combo into its key caps: "⌘⇧F" → ["⌘","⇧","F"].
 *
 *  A run of letters is one cap, so "⌘⇧Enter" gives ["⌘","⇧","Enter"] rather
 *  than five boxes spelling E-n-t-e-r. `+` is a separator and never a cap,
 *  which is what lets a combo name something that isn't a key ("⇧+click").
 *
 *  This used to be a plain code-point split, and there were two more copies
 *  of that split elsewhere in the app. A single-letter alphabet is the only
 *  reason it ever worked. */
export function comboKeys(combo: string): string[] {
  return combo.match(/[A-Za-z]+|[^+\s]/gu) ?? [];
}
