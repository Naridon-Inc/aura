// The ＋ at the end of a workspace's tab strip: Chat, Terminal, Browser.
//
// Under them, "More…" opens the launcher — every installed agent, the tabs
// and sessions running elsewhere, the starts that need a choice first. The
// three common starts are one click; everything else is the one after it.

import { useRef, useState } from "react";
import { Ellipsis, Globe, Plus } from "lucide-react";

import { useEditorStore, type WorkSplitLeaf } from "../../lib/editorStore";
import { PaneAddPopover } from "../PaneAddPopover";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { startBrowser, startChat, startTerminal, type Place } from "./newTabStarts";
import "../ui/new-tab.css";

/** `.ui-launcher-popover`'s width. */
const LAUNCHER_WIDTH = 420;

export function NewTabMenu({
  repoRoot,
  place,
  leaf,
}: {
  /** The workspace a chat or terminal started here belongs to. */
  repoRoot: string;
  /** Where a start lands: a tab on this pane, or a fresh layout when the
   *  strip has no tabs at all. */
  place: Place;
  /** The pane "More…" adds to; absent on the strip with no tabs. */
  leaf?: WorkSplitLeaf;
}) {
  const store = useEditorStore();
  const [more, setMore] = useState(false);
  // Whether the launcher has room to open rightward from the ＋; measured
  // when it opens, since the ＋ moves along the strip as tabs come and go.
  const [end, setEnd] = useState(false);
  const self = useRef<HTMLDivElement | null>(null);
  const openMore = () => {
    const left = self.current?.getBoundingClientRect().left ?? 0;
    setEnd(left + LAUNCHER_WIDTH > window.innerWidth - 8);
    setMore(true);
  };

  return (
    <div ref={self} className="ui-new-tab" data-end={end || undefined}>
      <DropdownMenu>
        <Tooltip content="New tab">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconXs" aria-label="New tab">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => void startChat(store, repoRoot, place)}>
            Chat
            <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => startTerminal(store, repoRoot, place)}>
            Terminal
          </DropdownMenuItem>
          <DropdownMenuItem className="ui-new-tab-item" onSelect={() => startBrowser(place)}>
            <Globe />
            Browser
            <DropdownMenuShortcut>⌘⇧B</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="ui-new-tab-item" onSelect={openMore}>
            <Ellipsis />
            More…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {more && (
        <PaneAddPopover
          leaf={leaf}
          currentRepoRoot={repoRoot}
          onClose={() => setMore(false)}
        />
      )}
    </div>
  );
}
