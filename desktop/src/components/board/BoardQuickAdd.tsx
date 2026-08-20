// The quick-add row pinned to the bottom of a board column.
//
// Plane puts a "+ New issue" affordance in every lane so you can capture work
// straight into the state it belongs in, without opening a dialog and picking
// the status by hand. Collapsed it is a quiet ghost row; clicked it becomes an
// inline input that stays open after each commit so you can type a stack of
// cards in one go.
//
// Tab hops to the next lane's input. That's implemented by stamping a stable
// `data-board-quick-add` attribute on each input and walking the DOM, rather
// than lifting "which lane is focused" into every board's state — the boards
// that use this have nothing else to say about it.

import { useState, type JSX } from "react";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";

/** The DOM hook Tab-between-lanes walks. Exported so a caller could target it
 *  in a test or a focus helper without re-deriving the string. */
export const BOARD_QUICK_ADD_ATTR = "data-board-quick-add";

export function BoardQuickAdd({
  columnId,
  columnIds,
  label = "New task",
  placeholder = "Title. Enter to add",
  onCreate,
}: {
  /** This lane's id — stamped on the input so Tab can find its siblings. */
  columnId: string;
  /** Every lane id on this board, in render order. Tab wraps around the end. */
  columnIds: string[];
  label?: string;
  placeholder?: string;
  onCreate: (title: string) => Promise<void> | void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function commit(): Promise<void> {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onCreate(t);
      setTitle("");
    } finally {
      setBusy(false);
    }
  }

  function focusSibling(dir: 1 | -1): void {
    const idx = columnIds.indexOf(columnId);
    if (idx < 0 || columnIds.length === 0) return;
    const next = columnIds[(idx + dir + columnIds.length) % columnIds.length];
    if (next == null) return;
    const sel = `[${BOARD_QUICK_ADD_ATTR}="${next}"]`;
    // The sibling lane's input is probably still collapsed — click its ghost
    // row to mount the input, then focus on the next frame once it exists.
    const existing = document.querySelector<HTMLInputElement>(`input${sel}`);
    if (!existing) {
      document.querySelector<HTMLButtonElement>(`button${sel}`)?.click();
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(`input${sel}`)?.focus();
    });
  }

  return (
    // Sticky to the foot of the lane and painted with the board background, so
    // it stays reachable while a long lane scrolls underneath it.
    <div className="sticky bottom-0 z-10 bg-bg-1 px-1 pb-1 pt-1.5">
      {open ? (
        <Input
          autoFocus
          type="text"
          value={title}
          disabled={busy}
          placeholder={placeholder}
          className="w-full"
          {...{ [BOARD_QUICK_ADD_ATTR]: columnId }}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (!title.trim()) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setTitle("");
            } else if (e.key === "Tab") {
              e.preventDefault();
              focusSibling(e.shiftKey ? -1 : 1);
            }
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          {...{ [BOARD_QUICK_ADD_ATTR]: columnId }}
          className="flex w-full items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-left text-base font-medium text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          {label}
        </button>
      )}
    </div>
  );
}
