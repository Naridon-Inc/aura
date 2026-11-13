// The `+` menu for the terminal panel toolbar — mirrors VS Code's
// "New Terminal" dropdown. New / New Window (popout) / Split, the list
// of configured profiles, a "Split with Another Shell" submenu, and the
// settings + default-profile affordances. Built on the shared Radix
// `DropdownMenu` so submenus + the radio group come for free and the
// menu portals out of the panel's clipped overflow.

import type { ReactNode } from "react";
import { Plus, SquareArrowOutUpRight, Settings, FolderOpen } from "lucide-react";
import type { TerminalProfile } from "../../lib/api";
import { tildePath } from "../../lib/agentInstallHealth";
import { folderLabel, folderParent } from "../../lib/terminalFolders";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
} from "../ui/dropdown-menu";
import { SplitIcon } from "./icons";

type ItemProps = {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  /** Open a new terminal. `profileId` undefined ⇒ default profile. */
  onNewTerminal: (profileId?: string) => void;
  /** Split the active terminal. `profileId` undefined ⇒ same profile. */
  onSplit: (profileId?: string) => void;
  /** Open a terminal in a folder of the user's choosing. `folder` undefined
   *  ⇒ ask for one; `profileId` undefined ⇒ default profile. Omit to hide
   *  the whole folder submenu (surfaces with no picker to offer). */
  onNewTerminalInFolder?: (profileId?: string, folder?: string) => void;
  /** Folders already opened this way, newest first — the quick second trip. */
  recentFolders?: string[];
  /** Pop the active terminal out into its own OS window. Omit to hide the
   *  item (the popout `terminal` kind lands in Term W4). */
  onNewWindow?: () => void;
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
};

type Props = ItemProps & {
  trigger: ReactNode;
  align?: "start" | "end";
};

export function TerminalNewMenu({ trigger, align = "end", ...items }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[14rem] max-w-[20rem]">
        <TerminalNewMenuItems {...items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu's rows, for a menu that hosts them as a submenu. */
export function TerminalNewMenuItems({
  profiles,
  defaultProfileId,
  onNewTerminal,
  onSplit,
  onNewWindow,
  onNewTerminalInFolder,
  recentFolders = [],
  onSelectDefaultProfile,
  onConfigureSettings,
}: ItemProps) {
  return (
    <>
        <DropdownMenuItem onSelect={() => onNewTerminal()}>
          <Plus />
          New Terminal
          <DropdownMenuShortcut>⌃⇧`</DropdownMenuShortcut>
        </DropdownMenuItem>
        {onNewWindow && (
          <DropdownMenuItem onSelect={onNewWindow}>
            <SquareArrowOutUpRight />
            New Terminal Window
            <DropdownMenuShortcut>⌃⇧⌥`</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onSplit()}>
          <SplitIcon />
          Split Terminal
          <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
        </DropdownMenuItem>

        {/* Any folder on disk, not just the open project — the shell you want
            is as often for a sibling repo or a log directory. The shell is
            chosen in the same breath as the folder, and folders picked before
            come back as rows so the second visit is one click. */}
        {onNewTerminalInFolder && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderOpen />
              New Terminal in Folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[15rem] max-w-[22rem]">
              <DropdownMenuItem onSelect={() => onNewTerminalInFolder()}>
                <FolderOpen />
                Choose Folder…
              </DropdownMenuItem>
              {profiles.length > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Choose Folder, Then Shell</DropdownMenuLabel>
                  {profiles.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => onNewTerminalInFolder(p.id)}
                    >
                      <span className="font-mono text-text-4 text-2xs">{">_"}</span>
                      <span className="min-w-0 truncate">{p.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {recentFolders.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Folders You Opened</DropdownMenuLabel>
                  {recentFolders.map((folder) => (
                    <DropdownMenuItem
                      key={folder}
                      onSelect={() => onNewTerminalInFolder(undefined, folder)}
                    >
                      <span className="min-w-0 truncate">{folderLabel(folder)}</span>
                      <span className="ml-auto pl-3 min-w-0 truncate text-2xs text-text-4">
                        {tildePath(folderParent(folder))}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {profiles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              Shells
            </DropdownMenuLabel>
            {profiles.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => onNewTerminal(p.id)}>
                <span className="font-mono text-text-4 text-2xs">{">_"}</span>
                <span className="min-w-0 truncate">{p.name}</span>
                {p.id === defaultProfileId && (
                  <span className="ml-auto text-xs tracking-wider text-text-4">Default</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SplitIcon />
                Split with Another Shell
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {profiles.map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => onSplit(p.id)}>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onConfigureSettings}>
          <Settings />
          Terminal Settings
        </DropdownMenuItem>
        {profiles.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Choose the Default Shell</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={defaultProfileId ?? ""}
                onValueChange={onSelectDefaultProfile}
              >
                {profiles.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
    </>
  );
}
