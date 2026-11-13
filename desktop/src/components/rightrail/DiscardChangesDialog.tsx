// The confirmation before a file's changes are thrown away — asked from the
// changed-file list's menu and from the diff's own Discard button. A new
// file has no earlier version to go back to, so it says the file is deleted.

import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";

export type DiscardTarget = { path: string; untracked: boolean };

export function DiscardChangesDialog({
  target,
  onCancel,
  onConfirm,
}: {
  /** The file to discard; `null` keeps the dialog closed. */
  target: DiscardTarget | null;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogTitle>Discard changes?</DialogTitle>
        <DialogDescription>
          {target?.untracked
            ? `Delete ${target.path}. It is a new file, so nothing brings it back.`
            : `Put ${target?.path} back to how it was at the last commit.`}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (target) onConfirm(target.path);
            }}
          >
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
