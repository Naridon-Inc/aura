// DiffSaveState — the header furniture an editable diff needs, kept tiny so it
// sits in a row of existing controls without turning the strip into a card:
//
//  • `UnsavedMark`   — the dot beside the file name while the buffer is dirty,
//                      or the spinner while a save is in flight.
//  • `DiskChangedNotice` — "Changed on disk" with a Reload action, shown only
//                      when the file moved underneath unsaved edits.
//  • `EditToggle`    — "Edit in diff" / "Read only", the preference switch
//                      that lives beside the split/unified control.
//
// Plain words throughout: the people reading a diff here are not all
// engineers, and none of them should have to know what a buffer is.

import { AsciiSpinner } from "../ui/ascii-spinner";
import type { EditableDiffHandle } from "./useEditableDiff";

/** The unsaved dot (accent), or the one loader while saving. Renders nothing
 *  when the buffer is clean so the header is unchanged for a plain read. */
export function UnsavedMark({ edit }: { edit: Pick<EditableDiffHandle, "dirty" | "saving"> }) {
  if (edit.saving) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-text-4" title="Saving…">
        <AsciiSpinner className="text-2xs" />
      </span>
    );
  }
  if (!edit.dirty) return null;
  return (
    <span
      aria-label="Unsaved changes. Press ⌘S in the diff to save"
      title="Unsaved changes. Press ⌘S in the diff to save"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
    />
  );
}

/** Shown only when the file changed on disk while there were unsaved edits.
 *  The edits are kept; Reload is the explicit way to drop them. */
export function DiskChangedNotice({
  edit,
}: {
  edit: Pick<EditableDiffHandle, "diskChanged" | "reload" | "error">;
}) {
  if (edit.error) {
    return (
      <span className="inline-flex min-w-0 shrink items-center gap-1.5 text-xs text-text-3">
        <span className="truncate" title={edit.error}>
          Couldn&rsquo;t save
        </span>
      </span>
    );
  }
  if (!edit.diskChanged) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-text-3">
      <span>Changed on disk</span>
      <button
        type="button"
        onClick={edit.reload}
        className="rounded border border-line-soft px-1.5 py-px text-xs text-text-2 hover:bg-state-hover hover:text-text-1"
        title="Drop your unsaved edits and show the version now on disk"
      >
        Reload
      </button>
    </span>
  );
}

/** The preference switch. `on` is the current choice; clicking flips it for
 *  every open diff pane (the preference is shared and persisted). */
export function EditToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={
        on
          ? "You can type into the current side of this diff and press ⌘S to save. Click to make it read only"
          : "This diff is read only. Click to edit the current side in place"
      }
      className={
        "h-5 shrink-0 rounded border px-1.5 text-xs " +
        (on
          ? "border-[var(--color-accent)] bg-bg-2 text-[var(--color-accent)]"
          : "border-line-soft text-text-3 hover:text-text-1")
      }
    >
      {on ? "Edit in diff" : "Read only"}
    </button>
  );
}
