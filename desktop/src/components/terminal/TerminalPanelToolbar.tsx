// The terminal panel's own actions, drawn into the terminal strip after the
// tabs and the run controls: one More actions menu holding a new terminal in
// another shell or folder, split / find / close the active one, the terminal
// list, moving it into the editor area and maximizing the panel. The tabs and
// the new-terminal button are the strip's; these are what is left.

import {
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Plus,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { TerminalProfile } from "../../lib/api";
import { Button } from "../ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { SplitIcon } from "./icons";
import { TerminalNewMenuItems } from "./TerminalNewMenu";
import { TerminalOverflowMenu } from "./TerminalOverflowMenu";

/** Every shell, split, a new window, a folder, the default shell and
 *  terminal settings — the rows of the "New Terminal" submenu. */
export type ShellMenuProps = {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  onNewTerminal: (profileId?: string) => void;
  onSplit: (profileId?: string) => void;
  onNewWindow?: () => void;
  /** Open a terminal in a folder the user picks. */
  onNewTerminalInFolder?: (profileId?: string, folder?: string) => void;
  /** Folders already opened that way, newest first. */
  recentFolders?: string[];
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
};

type ActionsProps = {
  /** Whether the active terminal has a current text selection (gates Copy). */
  hasSelection: boolean;
  maximized: boolean;
  sideListOpen: boolean;
  hasActive: boolean;
  onSplit: () => void;
  onKill: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFind: () => void;
  onToggleMaximize: () => void;
  /** Move the active terminal into the center editor area as its own tab. */
  onOpenInEditor: () => void;
  onToggleSideList: () => void;
  /** The shells a new terminal can open in. */
  shellMenu: ShellMenuProps;
};

export function TerminalPanelActions({
  hasSelection,
  maximized,
  sideListOpen,
  hasActive,
  onSplit,
  onKill,
  onClear,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onToggleMaximize,
  onOpenInEditor,
  onToggleSideList,
  shellMenu,
}: ActionsProps) {
  return (
    <TerminalOverflowMenu
      trigger={
        <Button size="iconXs" variant="ghost" aria-label="More actions">
          <MoreHorizontal />
        </Button>
      }
      hasSelection={hasSelection && hasActive}
      canPaste={hasActive}
      onClear={onClear}
      onCopy={onCopy}
      onPaste={onPaste}
      onSelectAll={onSelectAll}
      onKill={onKill}
      extra={
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Plus />
              New Terminal
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[14rem] max-w-[20rem]">
              <TerminalNewMenuItems {...shellMenu} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSplit} disabled={!hasActive}>
            <SplitIcon />
            Split Terminal
            <DropdownMenuShortcut>{"⌘\\"}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFind} disabled={!hasActive}>
            <Search />
            Find
            <DropdownMenuShortcut>⌘F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenInEditor} disabled={!hasActive}>
            <SquareArrowOutUpRight />
            Open Terminal in Editor
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleSideList}>
            {sideListOpen ? <PanelRightClose /> : <PanelRight />}
            {sideListOpen ? "Hide Terminal List" : "Show Terminal List"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleMaximize}>
            {maximized ? <ChevronDown /> : <ChevronUp />}
            {maximized ? "Restore Panel" : "Maximize Panel"}
          </DropdownMenuItem>
        </>
      }
    />
  );
}
