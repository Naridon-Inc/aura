// useTaskShortcuts — OO.2 Phase 2 (Plane parity).
//
// Single-key shortcuts that fire only when a task is "focused" — i.e.
// the user clicked / arrow-navigated to a specific card. Mirrors
// Plane's bindings exactly:
//
//   Enter   open detail (right side-panel)
//   Esc     deselect / close detail
//   a       open assignee picker (signals parent via onShortcut)
//   p       open priority picker
//   s       open status picker
//   l       open label picker
//   c       copy `AURA-{n}` id to clipboard
//   d       delete task (with confirmation handled by parent)
//   ?       show the Shortcuts modal
//
// The hook does the boring half (key trapping, ignore-when-typing,
// modifier filtering) and emits a typed action via `onShortcut`. The
// parent picks the action it cares about — most actions just open a
// popover; a couple (Enter / Esc / copy) are handled here for
// convenience.
//
// Why a hook rather than a global listener: the binding is contextual
// — single-letter shortcuts can't fire while the user is typing in a
// title field or the description textarea. Scoping the listener to
// when `taskId !== null` keeps the binding off the keymap surface
// outside of the tasks board.

import { useEffect } from "react";

export type TaskShortcutAction =
  | "open"
  | "close"
  | "assignee"
  | "priority"
  | "status"
  | "label"
  | "copy_id"
  | "delete"
  | "help";

type Options = {
  /** Focused task id, or null when no task is focused. The hook is
   *  a no-op when `null` so the global keymap is unaffected. */
  taskId: string | null;
  /** The `sequence_id` of the focused task. Needed so `c` can write
   *  `AURA-{n}` to the clipboard without a round-trip back to the
   *  parent. Falls back to no-op when 0 (legacy un-healed row). */
  sequenceId: number;
  /** Emit an action — `open` / `close` are typically handled by the
   *  parent flipping `selectedId` / `peekId`. The picker actions
   *  (`assignee` / `priority` / ...) open the corresponding popover
   *  inside the detail card. The hook itself owns `copy_id`. */
  onShortcut: (action: TaskShortcutAction) => void;
  /** Disable when a modal is open above the board so shortcuts don't
   *  accidentally fire while the user is filling out the create form. */
  disabled?: boolean;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TYPING_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useTaskShortcuts({
  taskId,
  sequenceId,
  onShortcut,
  disabled = false,
}: Options) {
  useEffect(() => {
    if (disabled) return;

    function onKey(e: KeyboardEvent) {
      // Ignore composed key events (IME composition for CJK) and
      // anything fired with a modifier — the kanban's drag/drop +
      // copy/paste have their own keymap.
      if (e.defaultPrevented) return;
      if (e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // Esc / Enter / ? are always live; the rest only when a card
      // is focused.
      if (e.key === "Escape") {
        onShortcut("close");
        return;
      }
      if (e.key === "?") {
        onShortcut("help");
        return;
      }
      if (taskId === null) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onShortcut("open");
        return;
      }

      // Single-letter shortcuts. `key` rather than `code` so a
      // non-QWERTY layout still hits the right action (Plane does
      // the same — they're mnemonic, not positional).
      switch (e.key.toLowerCase()) {
        case "a":
          e.preventDefault();
          onShortcut("assignee");
          break;
        case "p":
          e.preventDefault();
          onShortcut("priority");
          break;
        case "s":
          e.preventDefault();
          onShortcut("status");
          break;
        case "l":
          e.preventDefault();
          onShortcut("label");
          break;
        case "c":
          e.preventDefault();
          if (sequenceId > 0) {
            try {
              void navigator.clipboard.writeText(`AURA-${sequenceId}`);
            } catch {
              // Clipboard rejected; surface via the parent which can
              // show a toast if it wants.
            }
          }
          onShortcut("copy_id");
          break;
        case "d":
          e.preventDefault();
          onShortcut("delete");
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, sequenceId, onShortcut, disabled]);
}

// Static metadata for the Shortcuts modal. Exported so the modal +
// any external help surface stay in sync with the binding above.
export const TASK_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "Enter", label: "Open task detail" },
  { keys: "Esc", label: "Close detail / deselect" },
  { keys: "Shift+click", label: "Peek task in a centered modal" },
  { keys: "a", label: "Open assignee picker" },
  { keys: "p", label: "Open priority picker" },
  { keys: "s", label: "Open status picker" },
  { keys: "l", label: "Open label picker" },
  { keys: "c", label: "Copy AURA-{n} to clipboard" },
  { keys: "d", label: "Delete task" },
  { keys: "?", label: "Show this shortcuts list" },
];
