import { BookOpen, CircleHelp, Compass, Keyboard } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { openExternal } from "../../lib/openExternal";

const DOCS_URL = "https://auravcs.com/docs";

/** The footer's help button: tour, shortcuts, documentation. */
export function HelpMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="iconSm" aria-label="Help">
          <CircleHelp />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end">
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("aura:start-tour"))}>
          <Compass />
          Take the tour
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.dispatchEvent(new CustomEvent("aura:open-shortcuts"))}
        >
          <Keyboard />
          Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openExternal(DOCS_URL)}>
          <BookOpen />
          Documentation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
