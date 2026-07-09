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
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onKill: () => void;
  align?: "start" | "end";
};

export function TerminalOverflowMenu({
  trigger,
  hasSelection,
  onClear,
  onCopy,
  onPaste,
  onSelectAll,
  onKill,
  align = "end",
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[14rem]">
        <DropdownMenuItem onSelect={onCopy} disabled={!hasSelection}>
          <Copy />
          Copy Selection
          <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste}>
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
        <DropdownMenuItem onSelect={onKill} variant="destructive">
          <Trash2 />
          Kill Terminal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
