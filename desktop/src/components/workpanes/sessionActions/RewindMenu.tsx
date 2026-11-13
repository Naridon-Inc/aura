// Rewind, as a menu of exactly what this session touched. Aura reverts ONE
// thing — a single changed function (surgical, AST-level) or a single file —
// where a blanket restore takes unrelated work with it. That blunt restore
// stays available as the last, clearly-marked row, behind a confirm.

import { useState } from "react";
import { ChevronDown, FileText, RotateCcw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { useAfterMenuClose } from "../../ui/after-menu-close";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { changeWord, type RewindTarget } from "./sessionActionsModel";

export function RewindMenu({
  targets,
  commit,
  restoring,
  onRewind,
  onRestoreAll,
}: {
  targets: RewindTarget[];
  /** The commit "Restore everything" moves back to; null hides that row. */
  commit: string | null;
  restoring: boolean;
  /** Opens the Rewind tool on one function (identifier) or one whole file. */
  onRewind: (identifier: string | null, abs: string) => void;
  /** Resolves true when the restore ran, false when it failed. */
  onRestoreAll: () => Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState(false);
  const afterClose = useAfterMenuClose();
  const mapped = targets.some((t) => t.symbols.length > 0);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="secondary"
            title="Revert a single function or file to its last safe version"
          >
            <RotateCcw />
            Rewind
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="ui-rewind-menu"
          onCloseAutoFocus={afterClose.onCloseAutoFocus}
        >
          <DropdownMenuLabel>
            Rewind one piece
            <small>
              Everything else this session changed stays as it is. Aura snapshots first, so a
              rewind can itself be undone.
            </small>
          </DropdownMenuLabel>
          {targets.map((t) => (
            <div key={t.path} role="group" aria-label={t.path}>
              <DropdownMenuItem onSelect={() => onRewind(null, t.abs)} title={t.path}>
                <FileText />
                <span className="ui-rewind-path">{t.path}</span>
                {t.symbols.length === 0 && <DropdownMenuShortcut>whole file</DropdownMenuShortcut>}
              </DropdownMenuItem>
              {t.symbols.map((s) => (
                <DropdownMenuItem
                  key={`${t.path}::${s.identifier}`}
                  className="ui-rewind-symbol"
                  onSelect={() => onRewind(s.identifier, t.abs)}
                >
                  <RotateCcw />
                  <span className="ui-rewind-path">{s.identifier}</span>
                  <DropdownMenuShortcut data-change={s.change}>
                    {changeWord(s.change)}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
          {!mapped && (
            <p className="ui-rewind-note">
              No function map for this run. Pick a file, then choose the function in the next
              step.
            </p>
          )}
          {commit && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                // Opened once the menu has closed, so the confirm takes focus
                // rather than fighting the menu for it.
                onSelect={afterClose.later(() => setConfirm(true))}
              >
                Restore everything to this point…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {commit && (
        <AlertDialog open={confirm} onOpenChange={(o) => !restoring && setConfirm(o)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Move the whole repository back to {commit.slice(0, 7)}?</AlertDialogTitle>
              <AlertDialogDescription>
                This also undoes work unrelated to this session and leaves you off any branch. To
                undo one piece instead, pick it from the Rewind menu.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={restoring}
                onClick={async () => {
                  if (!(await onRestoreAll())) setConfirm(false);
                }}
              >
                {restoring ? "Restoring…" : "Restore everything"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
