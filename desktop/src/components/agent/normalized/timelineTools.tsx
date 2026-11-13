import { createContext, useContext, type ReactNode } from "react";
import { Check, Copy, Search } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "../../ui/dropdown-menu";

/** What the conversation offers from its composer's footer. The pane has no
 *  header row, so the Chat / CLI switch and the transcript's own search and
 *  copy ride in the footer every composer in it already draws. Provided by
 *  `ChatTimeline`; a composer outside one renders nothing for these. */
export type TimelineTools = {
  switcher?: ReactNode;
  /** The transcript is hidden behind the terminal, so searching or copying
   *  it would act on something you cannot see. */
  overlay: boolean;
  searchOpen: boolean;
  onToggleSearch: () => void;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
};

export const TimelineToolsContext = createContext<TimelineTools | null>(null);

/** The Chat / CLI switch, for the footer's left cluster. */
export function TimelineViewSwitch() {
  const tools = useContext(TimelineToolsContext);
  return <>{tools?.switcher ?? null}</>;
}

/** Search and copy as rows of the composer's add menu. */
export function TimelineMenuItems() {
  const tools = useContext(TimelineToolsContext);
  if (!tools || tools.overlay) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={tools.onToggleSearch}>
        <Search />
        {tools.searchOpen ? "Close search" : "Search conversation"}
        <DropdownMenuShortcut>⌘ F</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!tools.canCopy}
        onSelect={(event) => {
          // Stay open so "Copied" is seen where the click was.
          event.preventDefault();
          tools.onCopy();
        }}
      >
        {tools.copied ? <Check /> : <Copy />}
        {tools.copied ? "Copied conversation" : "Copy conversation"}
      </DropdownMenuItem>
    </>
  );
}
