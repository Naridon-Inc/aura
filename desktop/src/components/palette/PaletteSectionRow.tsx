// One row of a palette section, by its type: a fixed row (icon, name, key),
// a search result, a workspace, a repository, or the quiet "No results found"
// line that stands where a search found no workspace.

import { Search } from "lucide-react";

import { CommandItem, CommandShortcut } from "../ui/command";
import { Highlighted, PaletteResultRow } from "./PaletteRows";
import type { PaletteRow } from "./paletteSections";
import { PaletteWorkspaceRow, RepositoryPicture } from "./PaletteWorkspaceRow";

export function PaletteSectionRow({
  row,
  query,
  showNumber,
  onPick,
}: {
  row: PaletteRow;
  query: string;
  showNumber: boolean;
  onPick: (row: PaletteRow) => void;
}) {
  switch (row.type) {
    case "catalog":
      return (
        <CommandItem value={row.key} onSelect={() => onPick(row)}>
          {row.item.icon}
          <span className="ui-command-palette-label">
            <Highlighted text={row.item.label} query={query} />
          </span>
          {row.item.shortcut && <CommandShortcut>{row.item.shortcut}</CommandShortcut>}
        </CommandItem>
      );
    case "entry":
      return <PaletteResultRow entry={row.entry} query={query} onPick={() => onPick(row)} />;
    case "workspace":
      return <PaletteWorkspaceRow row={row.row} query={query} showNumber={showNumber} onPick={() => onPick(row)} />;
    case "repository":
      return (
        <CommandItem value={row.key} onSelect={() => onPick(row)}>
          <RepositoryPicture repo={row.repo.repo} name={row.repo.name} />
          <span className="ui-command-palette-label">
            <Highlighted text={row.repo.name} query={query} />
          </span>
        </CommandItem>
      );
    case "none":
      return (
        <CommandItem value={row.key} disabled className="ui-command-palette-none">
          <Search />
          <span>No results found</span>
        </CommandItem>
      );
  }
}
