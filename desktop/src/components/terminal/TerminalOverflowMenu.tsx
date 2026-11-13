// The `...` menu for the terminal panel toolbar — VS Code's terminal
// overflow. This pass wires the actions that operate on the live xterm
// buffer (clear / copy / paste / select-all) plus kill. The command-mark
// navigation items (Scroll to Prev/Next Command, Run Recent Command, Go
// to Recent Directory) depend on the shell-integration mark stream and
// land with that wiring in Term W4.

import type { ReactNode } from "react";
import { Eraser, Copy, ClipboardPaste, TextSelect, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "../ui/dropdown-menu";

type Props = {
  trigger: ReactNode;
  /** True when the active terminal currently has a text selection — gates
   *  Copy so it doesn't look actionable on an empty selection. */
  hasSelection: boolean;
  /** False for a pane that cannot be typed into — a session joined read-only.
   *  Clear and Select All are actions on the local grid and stay available;
   *  Paste writes to the session, so it does not. */
  canPaste?: boolean;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onKill: () => void;
  /** What the last item is called. A local terminal's close ends the shell, so
   *  it reads as destructive; closing the view of a session running on another
   *  machine leaves it running, and must not. */
  killLabel?: string;
  killDestructive?: boolean;
  align?: "start" | "end";
  /** Rows drawn first, above the selection rows. */
  extra?: ReactNode;
};

export function TerminalOverflowMenu({
  trigger,
  hasSelection,
  canPaste = true,
  onClear,
  onCopy,
  onPaste,
  onSelectAll,
  onKill,
  killLabel = "Close Terminal",
  killDestructive = true,
  align = "end",
  extra,
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[14rem]">
        {extra}
        {extra && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCopy} disabled={!hasSelection}>
          <Copy />
          Copy Selection
          <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste} disabled={!canPaste}>
          <ClipboardPaste />
          Paste
          <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSelectAll}>
          <TextSelect />
          Select All
          <DropdownMenuShortcut>⌘A</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClear}>
          <Eraser />
          Clear Terminal
          <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onKill}
          variant={killDestructive ? "destructive" : "default"}
        >
          <Trash2 />
          {killLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
