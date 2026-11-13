// DiffSaveState — the header furniture an editable diff needs, kept tiny so it
// sits in a row of existing controls without turning the strip into a card:
//
//  • `UnsavedMark`   — "Unsaved" beside the counts while the buffer is dirty,
//                      or the loader while a save is in flight.
//  • `DiskChangedNotice` — "Changed on disk" with a Reload action, shown only
//                      when the file moved underneath unsaved edits.
//  • `EditToggle`    — "Edit in diff", the preference switch that lives beside
//                      the split/unified control.
//
// Plain words throughout: the people reading a diff here are not all
// engineers, and none of them should have to know what a buffer is.

import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import type { EditableDiffHandle } from "./useEditableDiff";
import "../ui/diff-save-state.css";

/** "Unsaved", the way the file view says it, or the one loader while saving.
 *  Renders nothing when the buffer is clean so the header is unchanged for a
 *  plain read. */
export function UnsavedMark({ edit }: { edit: Pick<EditableDiffHandle, "dirty" | "saving"> }) {
  if (edit.saving) {
    return (
      <span className="ui-diff-save-state" title="Saving…">
        <AsciiSpinner size={10} />
      </span>
    );
  }
  if (!edit.dirty) return null;
  return (
    <small className="ui-diff-save-state" title="Unsaved changes. Press ⌘S in the diff to save">
      Unsaved
    </small>
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
      <small className="ui-diff-save-state" data-tone="bad" title={edit.error}>
        Couldn&rsquo;t save
      </small>
    );
  }
  if (!edit.diskChanged) return null;
  return (
    <span className="ui-diff-save-state">
      Changed on disk
      <Button
        size="xs"
        variant="outline"
        onClick={edit.reload}
        title="Drop your unsaved edits and show the version now on disk"
      >
        Reload
      </Button>
    </span>
  );
}

/** The preference switch. `on` is the current choice; pressing flips it for
 *  every open diff pane (the preference is shared and persisted). */
export function EditToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Toggle
      size="sm"
      pressed={on}
      onPressedChange={onChange}
      title={
        on
          ? "You can type into the current side of this diff and press ⌘S to save. Press to make it read only"
          : "This diff is read only. Press to edit the current side in place"
      }
    >
      Edit in diff
    </Toggle>
  );
}
