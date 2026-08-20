// The `+` menu for the terminal panel toolbar — mirrors VS Code's
// "New Terminal" dropdown. New / New Window (popout) / Split, the list
// of configured profiles, a "Split with Another Shell" submenu, and the
// settings + default-profile affordances. Built on the shared Radix
// `DropdownMenu` so submenus + the radio group come for free and the
// menu portals out of the panel's clipped overflow.

import type { ReactNode } from "react";
import { Plus, SquareArrowOutUpRight, Settings } from "lucide-react";
import type { TerminalProfile } from "../../lib/api";
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

type Props = {
  trigger: ReactNode;
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  /** Open a new terminal. `profileId` undefined ⇒ default profile. */
  onNewTerminal: (profileId?: string) => void;
  /** Split the active terminal. `profileId` undefined ⇒ same profile. */
  onSplit: (profileId?: string) => void;
  /** Pop the active terminal out into its own OS window. Omit to hide the
   *  item (the popout `terminal` kind lands in Term W4). */
  onNewWindow?: () => void;
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
  align?: "start" | "end";
};

export function TerminalNewMenu({
  trigger,
  profiles,
  defaultProfileId,
  onNewTerminal,
  onSplit,
  onNewWindow,
  onSelectDefaultProfile,
  onConfigureSettings,
  align = "end",
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[14rem] max-w-[20rem]">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
