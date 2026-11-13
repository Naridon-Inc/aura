// The split control over a pane of a remote workspace.
//
// A local split button makes a second terminal, because a shell on your own
// machine is free. Nothing here can mean that: a session on a box is a thing
// someone started on purpose, it already has a tab, and starting another one is
// ＋ — a project and an agent to choose, with consequences on the machine. So
// this menu is the other half of the same idea, the half that is actually
// wanted when the work is somewhere else: show me two of these at once.
//
// Its rows are therefore the tabs you already have open, not shells to spawn.
// The direction lives in a submenu rather than in two buttons, because the
// question is "which one" first and "where" second — you pick the build log,
// then decide whether it goes beside the agent or under it.

import type { ReactNode } from "react";
import { Columns2, Rows2, Square } from "lucide-react";

import type { RemotePaneDirection } from "../../lib/remotePaneTree";
import type { RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { remoteTabLabel } from "./remoteTabFace";

type Props = {
  trigger: ReactNode;
  /** The other open tabs that could join this pane, in strip order. Empty
   *  means there is no room left — said in words below rather than by a menu
   *  that opens onto nothing. */
  candidates: RemoteTab[];
  /** Whether this pane is currently sharing the body with others. */
  inSplit: boolean;
  onShowBeside: (tabId: string, direction: RemotePaneDirection) => void;
  /** Give the whole body back to this pane. Closes nothing — every other pane
   *  is a tab and stays on the strip. */
  onShowAlone: () => void;
  align?: "start" | "end";
};

export function RemoteSplitMenu({
  trigger,
  candidates,
  inSplit,
  onShowBeside,
  onShowAlone,
  align = "end",
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[15rem]">
        <DropdownMenuLabel>Show beside this one</DropdownMenuLabel>
        {candidates.length === 0 ? (
          <DropdownMenuItem disabled>
            {inSplit ? "No room for another pane" : "Nothing else open here"}
          </DropdownMenuItem>
        ) : (
          candidates.map((tab) => (
            <DropdownMenuSub key={tab.id}>
              <DropdownMenuSubTrigger>
                <span className="truncate">{remoteTabLabel(tab)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => onShowBeside(tab.id, "row")}>
                  <Columns2 />
                  To the Right
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onShowBeside(tab.id, "column")}>
                  <Rows2 />
                  Below
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
        {inSplit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onShowAlone}>
              <Square />
              Show This One Alone
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
